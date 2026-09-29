/**
 * `TerminalPrompter` 的回归测试（TD13）。
 *
 * 这个类以前没法测：它直接读写 `process.stdin` / `process.stdout`。T11 把两条流变成
 * 构造参数（不传就是真实终端），于是可以在测试里喂它几行、看它回什么。
 *
 * 为什么值得专门测它——它踩的三个坑，每一个都会让**整批笔记一条都不写**，
 * 而用户看到的只是「什么都没发生」：
 *   1. 管道一次性喂进来的好几行，先到的那几行被丢掉（用 `question()` 时的老毛病）；
 *   2. 输入结束时悬着的 `await` 永远不返回，事件循环空了，进程以退出码 0 静默退出；
 *   3. 关掉之后再问会抛异常。
 * 这三种都不是「终端里手敲」的用法，但都是脚本和演示会用的正经用法。
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { TerminalPrompter } from '../src/commands/add.js';
import type { ChatFunction, NoteDraft, UncertainItem } from '../src/core/contracts.js';
import { EXIT } from '../src/core/errors.js';
import { TAG_VOCABULARY_PLACEHOLDER } from '../src/core/prompt.js';
import { listNoteFiles, vaultPaths, type VaultPaths } from '../src/io/vault.js';
import { runAdd, type NotePreview, type UncertainPreview } from '../src/pipeline.js';

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

function tempVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'learnmate-prompter-'));
  tempRoots.push(root);
  return vaultPaths(root);
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * 把提示语收起来的小水槽。
 *
 * 用 `Writable` 而不是 `on('data')`：`_write` 是**同步**调的，所以 `await` 一返回，
 * 屏幕上该有的字就都已经在里面了，断言不用等 tick。
 */
class Collector extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

interface Harness {
  prompter: TerminalPrompter;
  input: PassThrough;
  output: Collector;
}

function harness(): Harness {
  const input = new PassThrough();
  const output = new Collector();
  return { prompter: new TerminalPrompter({ input, output }), input, output };
}

const DRAFT: NoteDraft = {
  title: '素材加边缘光',
  summary: '先抠出发光部分，再用 乙插件 让它发光。',
  language: 'zh',
  tags: ['AE', '边缘光'],
  blocks: [{ type: 'text', text: '在阴影的基础上做。' }],
};

const MARKDOWN = '# 素材加边缘光\n\n先抠出发光部分，再用 乙插件 让它发光。';

function notePreview(overrides: Partial<NotePreview> = {}): NotePreview {
  return { index: 1, total: 2, draft: DRAFT, markdown: MARKDOWN, ...overrides };
}

const ITEM: UncertainItem = {
  text: '导出清晰：尺寸选择 4K',
  reason: '原文没说是合成尺寸还是导出尺寸。',
};

function uncertainPreview(overrides: Partial<UncertainPreview> = {}): UncertainPreview {
  return { noteIndex: 1, noteTotal: 2, index: 1, total: 1, item: ITEM, ...overrides };
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('TerminalPrompter', () => {
  it('一次性喂进来的好几行都不丢', async () => {
    const { prompter, input } = harness();
    // `printf 'y\nn\n' | learnmate add …`：两行在同一口气里到达。
    input.write('y\nn\n');

    assert.equal(await prompter.confirmNote(notePreview({ index: 1 })), 'write');
    assert.equal(await prompter.confirmNote(notePreview({ index: 2 })), 'skip');
    prompter.close();
  });

  it('输入结束时不再悬着：正等着的 confirmNote 拿到 quit', async () => {
    const { prompter, input } = harness();
    const pending = prompter.confirmNote(notePreview());
    // 管道结束 / Ctrl+D：这一刻悬念本该解掉，而不是让进程静默退出。
    input.end();

    assert.equal(await pending, 'quit');
    prompter.close();
  });

  it('存疑裁定：k 与空行保留、d 删除、e 改写', async () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['k\n', { action: 'keep' }],
      ['\n', { action: 'keep' }],
      ['d\n', { action: 'drop' }],
      ['e\n4K 指导出尺寸\n', { action: 'edit', text: '4K 指导出尺寸' }],
      ['e\n\n', { action: 'keep' }],
    ];

    for (const [answer, expected] of cases) {
      const { prompter, input } = harness();
      input.write(answer);
      assert.deepEqual(await prompter.resolveUncertain(uncertainPreview()), expected, answer);
      prompter.close();
    }
  });

  it('答非所问时不猜：说一句「没看懂」再问一次', async () => {
    const { prompter, input, output } = harness();
    input.write('x\ny\n');

    assert.equal(await prompter.confirmNote(notePreview()), 'write');
    assert.match(output.text(), /没看懂/);
    prompter.close();
  });

  it('close() 之后再问：按「没有更多回答」处理，不抛异常', async () => {
    const { prompter } = harness();
    prompter.close();

    assert.equal(await prompter.confirmNote(notePreview()), 'quit');
    assert.deepEqual(await prompter.resolveUncertain(uncertainPreview()), { action: 'keep' });
  });

  it('预览正文原样打在屏幕上', async () => {
    const { prompter, input, output } = harness();
    input.write('y\n');

    await prompter.confirmNote(notePreview());

    assert.ok(output.text().includes(MARKDOWN), '用户看的就是这篇正文');
    assert.ok(output.text().includes('素材加边缘光'), '标题要看得见');
    assert.ok(output.text().includes('tags: AE · 边缘光'), '标签要看得见');
    prompter.close();
  });

  it('--yes 全程不碰输入流（readline 接口是懒创建的）', async () => {
    const paths = tempVault();
    const input = new PassThrough();
    const prompter = new TerminalPrompter({ input, output: new Collector() });
    // 管道里预先放着几行回答——真实场景里这可能是上游命令的输出。
    input.write('y\ny\ny\n');

    const code = await runAdd('素材加边缘光：抠出发光部分，加 乙插件。', {
      paths,
      template: `你是录入员。\n\n已有标签词表：\n${TAG_VOCABULARY_PLACEHOLDER}\n\n只输出 JSON。`,
      model: 'fake-model',
      promptVersion: 'analyze.v1',
      chat: fakeChat(),
      maxInputChars: 20_000,
      now: () => new Date('2026-09-28T13:31:26.000Z'),
      yes: true,
      prompter,
    });

    assert.equal(code, EXIT.OK);
    assert.equal(listNoteFiles(paths).length, 1, '--yes 等于全部接受，笔记要落盘');
    // 一个字节都没被读走。被读走就说明 readline 接口被创建过——那正是要避免的事。
    assert.equal(input.readableLength, 6);
    prompter.close();
  });
});

/** 一条合法回应的假模型：不联网，只为让 `runAdd` 走到最后一步。 */
function fakeChat(): ChatFunction {
  return () =>
    Promise.resolve({
      text: JSON.stringify({
        notes: [
          {
            title: '素材加边缘光',
            summary: '先抠出发光部分，再用 乙插件 让它发光。',
            language: 'zh',
            tags: ['AE'],
            blocks: [{ type: 'text', text: '在阴影的基础上做。' }],
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 7,
      model: 'fake-model',
    });
}
