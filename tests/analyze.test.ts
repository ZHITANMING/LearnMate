/**
 * `core/analyze.ts` 的测试。
 *
 * 这个文件的全部价值浓缩成一句话：**校验失败才重试，网络失败不重试。**
 * 两种失败长得像、处理方式却相反，所以下面正反两面都钉死了：坏输出必须被
 * 送回模型改（并且要带上「哪里不对」和它自己上一次写的原文），而 `LlmError`
 * 必须一次就往外抛——拿同一个请求再打一遍只会再撞一次，代价是你多等两三倍时间。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ChatFunction, ChatMessage } from '../src/core/contracts.js';
import { DEFAULT_MAX_RETRIES, analyze } from '../src/core/analyze.js';
import { EXIT, LlmError, UsageError, ValidationError } from '../src/core/errors.js';
import { TAG_VOCABULARY_PLACEHOLDER } from '../src/core/prompt.js';

const TEMPLATE = `你是录入员。\n\n已有标签词表：\n${TAG_VOCABULARY_PLACEHOLDER}\n\n只输出 JSON。`;
const INPUT = '素材加边缘光：抠出发光部分，加 乙插件。';

const GOOD = JSON.stringify({
  notes: [
    {
      title: '素材加边缘光',
      summary: '先把发光部分抠出来，再让它发光。',
      tags: ['AE'],
      blocks: [{ type: 'text', text: '在阴影的基础上做。' }],
    },
  ],
});

/** 合法 JSON，但 title 是空字符串——校验过不去。 */
const BAD = JSON.stringify({
  notes: [
    { title: '', summary: '一句话。', tags: ['AE'], blocks: [{ type: 'text', text: '一段话。' }] },
  ],
});

interface FakeChat {
  chat: ChatFunction;
  /** 每次调用收到的消息快照。 */
  calls: ChatMessage[][];
}

/** 按顺序返回给定的回应；给完之后一直重复最后一个。 */
function fakeChat(replies: readonly string[]): FakeChat {
  const calls: ChatMessage[][] = [];
  const chat: ChatFunction = (messages) => {
    calls.push(messages.map((message) => ({ ...message })));
    const index = Math.min(calls.length - 1, replies.length - 1);
    return Promise.resolve({
      text: replies[index] ?? '',
      usage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 7,
      model: 'fake-model',
    });
  };
  return { chat, calls };
}

describe('analyze：顺利的情况', () => {
  it('一次就过，用量、耗时、模型名都原样带回来', async () => {
    const { chat, calls } = fakeChat([GOOD]);
    const outcome = await analyze({ template: TEMPLATE, tags: ['AE'], input: INPUT, chat });

    assert.equal(outcome.attempts, 1);
    assert.equal(calls.length, 1);
    assert.equal(outcome.result.notes.length, 1);
    assert.equal(outcome.result.notes[0]?.title, '素材加边缘光');
    assert.deepEqual(outcome.usage, { inputTokens: 100, outputTokens: 50 });
    assert.equal(outcome.latencyMs, 7);
    assert.equal(outcome.model, 'fake-model');
    assert.equal(outcome.rawOutput, GOOD);
  });

  it('第一条是系统消息（提示词），第二条是用户消息（原文）', async () => {
    const { chat, calls } = fakeChat([GOOD]);
    await analyze({ template: TEMPLATE, tags: ['AE', '甲脚本'], input: INPUT, chat });

    const sent = calls[0];
    assert.equal(sent?.length, 2);
    assert.equal(sent?.[0]?.role, 'system');
    assert.equal(sent?.[1]?.role, 'user');
    assert.equal(sent?.[1]?.content, INPUT, '用户原文必须原样作为用户消息，不能拼进提示词');
    assert.ok(sent?.[0]?.content.includes('- AE\n- 甲脚本'), '标签词表要注入到提示词里');
    assert.ok(!sent?.[0]?.content.includes('{{'), '不能把裸露的占位符发出去');
    assert.ok(!sent?.[0]?.content.includes(INPUT), '原文绝不能混进系统消息');
  });

  it('模型回了 0 条也算成功（契约 4.1 允许，退出码 0）', async () => {
    const { chat } = fakeChat(['{"notes": []}']);
    const outcome = await analyze({ template: TEMPLATE, tags: [], input: INPUT, chat });
    assert.equal(outcome.result.notes.length, 0);
    assert.equal(outcome.attempts, 1);
  });

  it('最外层包了一层代码围栏也能认——为这个花钱重试不值得', async () => {
    const { chat, calls } = fakeChat([`\`\`\`json\n${GOOD}\n\`\`\``]);
    const outcome = await analyze({ template: TEMPLATE, tags: [], input: INPUT, chat });
    assert.equal(outcome.attempts, 1);
    assert.equal(calls.length, 1);
    assert.equal(outcome.result.notes[0]?.title, '素材加边缘光');
    assert.equal(outcome.rawOutput, `\`\`\`json\n${GOOD}\n\`\`\``, '带回来的是原样，没有被加工');
  });
});

describe('analyze：校验失败就带着错误重试', () => {
  it('第一次不合格、第二次合格：一共调两次，第二次能看到自己上次写了什么', async () => {
    const { chat, calls } = fakeChat([BAD, GOOD]);
    const outcome = await analyze({ template: TEMPLATE, tags: [], input: INPUT, chat });

    assert.equal(outcome.attempts, 2);
    assert.equal(calls.length, 2);
    assert.equal(outcome.result.notes[0]?.title, '素材加边缘光');

    const retry = calls[1];
    assert.equal(retry?.length, 4, '系统 + 原文 + 上次的产出 + 错误反馈');
    assert.deepEqual(
      retry?.map((message) => message.role),
      ['system', 'user', 'assistant', 'user'],
    );
    assert.equal(retry?.[2]?.content, BAD, '必须把它自己上一次的原文放回去');
    assert.match(retry?.[3]?.content ?? '', /没有通过校验/);
    assert.match(retry?.[3]?.content ?? '', /notes\[0\]\.title/, '要指出具体位置');
    assert.match(retry?.[3]?.content ?? '', /完整的/, '要它给完整的 JSON，不是补丁');
  });

  it('连回的内容根本不是一个 JSON 对象时，反馈里说清楚这件事', async () => {
    const { chat, calls } = fakeChat(['我不知道该怎么整理。', GOOD]);
    const outcome = await analyze({ template: TEMPLATE, tags: [], input: INPUT, chat });
    assert.equal(outcome.attempts, 2);
    assert.match(calls[1]?.[3]?.content ?? '', /不是一个能被 JSON.parse 解析的对象/);
    assert.match(calls[1]?.[3]?.content ?? '', /不加代码围栏/);
  });

  it('重试用尽就抛 ValidationError（退出码 3），每一次的原始产出都留着', async () => {
    const { chat, calls } = fakeChat([BAD]);
    await assert.rejects(
      analyze({ template: TEMPLATE, tags: [], input: INPUT, chat }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError, '应该是 ValidationError');
        assert.equal(error.exitCode, EXIT.VALIDATION);
        assert.equal(error.attempts, DEFAULT_MAX_RETRIES + 1);
        assert.equal(error.rawOutputs.length, DEFAULT_MAX_RETRIES + 1, '三次都必须留下来');
        assert.equal(error.rawOutput, BAD);
        assert.match(error.message, /连续 3 次/);
        assert.match(error.message, /不会丢/);
        return true;
      },
    );
    assert.equal(calls.length, DEFAULT_MAX_RETRIES + 1, '一共试 3 次：1 次原始 + 2 次重试');
  });

  it('maxRetries=0 时试一次就放弃', async () => {
    const { chat, calls } = fakeChat([BAD]);
    await assert.rejects(
      analyze({ template: TEMPLATE, tags: [], input: INPUT, chat, maxRetries: 0 }),
      ValidationError,
    );
    assert.equal(calls.length, 1);
  });

  it('多次重试的用量与耗时是累加的（账单要算全）', async () => {
    const { chat } = fakeChat([BAD, BAD, GOOD]);
    const outcome = await analyze({ template: TEMPLATE, tags: [], input: INPUT, chat, maxRetries: 2 });
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(outcome.usage, { inputTokens: 300, outputTokens: 150 });
    assert.equal(outcome.latencyMs, 21);
  });
});

describe('analyze：网络失败不重试', () => {
  it('chat 抛 LlmError 时原样往外抛，一次都不重试', async () => {
    let calls = 0;
    const chat: ChatFunction = () => {
      calls += 1;
      return Promise.reject(new LlmError('连不上模型服务。', { status: 500 }));
    };

    await assert.rejects(
      analyze({ template: TEMPLATE, tags: [], input: INPUT, chat }),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.exitCode, EXIT.LLM);
        assert.equal(error.status, 500);
        return true;
      },
    );
    assert.equal(calls, 1, '同一个请求再打一遍只会再撞一次，不该重试');
  });
});

describe('analyze：模板有问题时一步都不走', () => {
  it('提示词里没有占位符就直接抛 UsageError，并且一次模型都没调', async () => {
    const { chat, calls } = fakeChat([GOOD]);
    await assert.rejects(
      analyze({ template: '这里没有占位符。', tags: [], input: INPUT, chat }),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.equal(error.exitCode, EXIT.USAGE);
        return true;
      },
    );
    assert.equal(calls.length, 0, '模板都坏了，绝不能发请求');
  });
});
