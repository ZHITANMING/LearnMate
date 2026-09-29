/**
 * `io/llm.ts` 的测试。
 *
 * 这是全项目唯一发网络请求的地方，也是唯一「拿着密钥」的地方。所以这里除了钉住
 * 请求长什么样，还钉住两件更要紧的事：
 *   1. **密钥绝不出现在任何错误信息里**——错误信息会被打印、会被贴进 issue；
 *   2. **每一种失败都翻译成一句能照着做的话**（401 说要查 Key、429 说别立刻重试、
 *      超时说要调 `requestTimeoutMs`），而不是把 `fetch failed` 原样扔给用户。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EXIT, LlmError } from '../src/core/errors.js';
import { createChatFunction } from '../src/io/llm.js';
import type { LlmClientOptions } from '../src/io/llm.js';
import type { ChatMessage } from '../src/core/contracts.js';

const API_KEY = 'sk-this-is-a-fake-key-0123456789';
const BASE_URL = 'https://api.deepseek.com/v1';

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: '你是录入员。' },
  { role: 'user', content: '素材加边缘光。' },
];

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const safeInit = init ?? {};
    calls.push({ url, init: safeInit });
    return Promise.resolve(handler(url, safeInit));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rawResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function completion(content: string): unknown {
  return {
    id: 'chatcmpl-1',
    model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  };
}

function client(fetchImpl: typeof fetch, overrides: Partial<LlmClientOptions> = {}) {
  return createChatFunction({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: 'deepseek-chat',
    timeoutMs: 5_000,
    fetchImpl,
    ...overrides,
  });
}

describe('createChatFunction：请求长什么样', () => {
  it('POST 到 <baseUrl>/chat/completions，带上 Key、模型和全部消息', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(completion('{"notes":[]}')));

    await client(impl)(MESSAGES);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call?.url, `${BASE_URL}/chat/completions`);
    assert.equal(call?.init.method, 'POST');

    const headers = call?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${API_KEY}`);
    assert.equal(headers['Content-Type'], 'application/json');

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    assert.deepEqual(body['messages'], MESSAGES, '消息要原样发出去，顺序都不能变');
    assert.equal(body['model'], 'deepseek-chat');
    assert.equal(body['stream'], false);
  });

  it('温度固定 0，并要求对方返回 JSON 对象', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(completion('{}')));
    await client(impl)(MESSAGES);

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['temperature'], 0, '重跑两次必须拿到同样的结果，不能主动加随机性');
    assert.deepEqual(body['response_format'], { type: 'json_object' });
  });

  it('把正文原样带回来，不在这里解析 JSON', async () => {
    const { impl } = fakeFetch(() => okResponse(completion('这不是 JSON，我就想看看会不会被动手脚')));
    const reply = await client(impl)(MESSAGES);

    assert.equal(reply.text, '这不是 JSON，我就想看看会不会被动手脚');
    assert.equal(reply.model, 'deepseek-chat');
    assert.deepEqual(reply.usage, { inputTokens: 120, outputTokens: 80 });
    assert.ok(typeof reply.latencyMs === 'number' && reply.latencyMs >= 0);
  });

  it('对方没给用量时不编一个 0 出来', async () => {
    const { impl } = fakeFetch(() => okResponse({ choices: [{ message: { content: '{}' } }] }));
    const reply = await client(impl)(MESSAGES);
    assert.deepEqual(reply.usage, {});
    assert.equal(reply.model, '', '对方没报模型名时是空字符串，不是 undefined');
  });
});

describe('createChatFunction：每一种失败都说一句能照着做的话', () => {
  it('401 说是 Key 的问题，并且**绝不**把密钥打出来', async () => {
    const { impl } = fakeFetch(() =>
      rawResponse(401, JSON.stringify({ error: { message: 'Authentication Fails' } })),
    );

    await assert.rejects(
      client(impl)(MESSAGES),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.exitCode, EXIT.LLM);
        assert.equal(error.status, 401);
        assert.match(error.message, /401/);
        assert.match(error.message, /Authentication Fails/, '对方说了什么要转达');
        assert.match(error.message, /API Key 不对/);
        assert.match(error.message, /apiKeyEnv/);
        assert.ok(!error.message.includes(API_KEY), '密钥绝不能出现在错误信息里');
        assert.ok(!error.message.includes('sk-'), '连着密钥的影子都不能有');
        return true;
      },
    );
  });

  it('429 说被限流，并解释为什么不自动重试', async () => {
    const { impl } = fakeFetch(() => rawResponse(429, '{"error":"rate limit exceeded"}'));
    await assert.rejects(client(impl)(MESSAGES), (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.status, 429);
      assert.match(error.message, /被限流/);
      assert.match(error.message, /rate limit exceeded/);
      assert.match(error.message, /不自动重试/);
      return true;
    });
  });

  it('400 提示可能是不支持 response_format', async () => {
    const { impl } = fakeFetch(() => rawResponse(400, '{"error":{"message":"bad request"}}'));
    await assert.rejects(client(impl)(MESSAGES), /response_format/);
  });

  it('5xx 说明是对方的问题', async () => {
    const { impl } = fakeFetch(() => rawResponse(503, 'service unavailable'));
    await assert.rejects(client(impl)(MESSAGES), /对方服务器/);
  });

  it('连不上时把底层原因（ENOTFOUND 之类）也说出来', async () => {
    const { impl } = fakeFetch(() => {
      const cause = new Error('getaddrinfo ENOTFOUND api.deepseek.com');
      throw new TypeError('fetch failed', { cause });
    });

    await assert.rejects(client(impl)(MESSAGES), (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /连不上模型服务/);
      assert.match(error.message, /ENOTFOUND/, '真正的病因必须露出来，否则没法排查');
      assert.equal(error.status, undefined, '没走到 HTTP 那一步，就不该假装有状态码');
      return true;
    });
  });

  it('超时会被中止，并告诉你调 requestTimeoutMs', async () => {
    const impl = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted.'));
        });
      })) as unknown as typeof fetch;

    await assert.rejects(client(impl, { timeoutMs: 10 })(MESSAGES), (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /没有在 10 毫秒内回应/);
      assert.match(error.message, /requestTimeoutMs/);
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
  });

  it('成功状态码但正文不是 JSON：算对方的问题（退出码 4），不是模型的输出不合契约', async () => {
    const { impl } = fakeFetch(() => rawResponse(200, '<html>502 Bad Gateway</html>'));
    await assert.rejects(client(impl)(MESSAGES), (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.exitCode, EXIT.LLM);
      assert.match(error.message, /不是 JSON/);
      return true;
    });
  });

  it('成功状态码但信封里没有 choices / 没有正文', async () => {
    const noChoices = fakeFetch(() => okResponse({ id: 'x', model: 'deepseek-chat' }));
    await assert.rejects(client(noChoices.impl)(MESSAGES), /没有 choices/);

    const noContent = fakeFetch(() => okResponse({ choices: [{ message: {} }] }));
    await assert.rejects(client(noContent.impl)(MESSAGES), /没有正文/);
  });

  it('错误信息里绝不出现密钥——逐个失败模式都过一遍', async () => {
    const failures: (() => Response)[] = [
      () => rawResponse(401, '{"error":"unauthorized"}'),
      () => rawResponse(429, '{"error":"slow down"}'),
      () => rawResponse(500, '{"error":"boom"}'),
      () => rawResponse(200, 'not json at all'),
      () => okResponse({ choices: [] }),
    ];

    for (const failure of failures) {
      const { impl } = fakeFetch(failure);
      await assert.rejects(client(impl)(MESSAGES), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          !error.message.includes(API_KEY) && !error.message.includes('sk-'),
          `错误信息里泄露了密钥：${error.message}`,
        );
        return true;
      });
    }
  });
});
