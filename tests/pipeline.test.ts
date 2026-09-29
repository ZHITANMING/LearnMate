/**
 * `pipeline.ts` 的测试 —— 也就是 T10 的五条验收要点。
 *
 * 这个文件里没有真实网络、没有真实终端、没有真实时钟：模型是一段假的 `ChatFunction`
 * （按脚本回话），预览是一段假的 `AddPrompter`（按脚本回答），id 与时间都是注入的。
 * 这么做的理由不是「测试要好写」，而是**这样才测得到该测的东西**：
 * 「用户按 n 之后磁盘上还剩什么」这种问题，用真终端和真模型都问不清楚。
 *
 * 验收要点与用例的对应关系：
 *   ① 按 n 跳过 → `notes/` 没有文件，`raw/` 与 `draft/` 保留
 *   ② `--dry-run` → 全程零写入
 *   ③ 重复输入 → 提示 + 退出 0；`--force` → 新 id、旧文件不动
 *   ④ TD8 重名守卫 → 一条都不写
 *   ⑤ 校验重试耗尽 → 原文与模型原始产出都留着，现场进 `quarantine/`，退出码 3
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatFunction,
  ChatMessage,
  LedgerInputOutcome,
  LedgerInputRow,
  LedgerNoteRow,
} from '../src/core/contracts.js';
import { EXIT, LlmError, UnsafeWriteError, UsageError, ValidationError } from '../src/core/errors.js';
import { TAG_VOCABULARY_PLACEHOLDER } from '../src/core/prompt.js';
import { readLedger } from '../src/io/ledger.js';
import {
  draftFilePath,
  ensureVaultLayout,
  fileExists,
  listNoteFiles,
  listResolutionFiles,
  noteFilePath,
  quarantineFilePath,
  rawFilePath,
  readDraft,
  readResolutions,
  resolutionFilePath,
  vaultPaths,
  type VaultPaths,
} from '../src/io/vault.js';
import {
  formatTimestamp,
  runAdd,
  type AddOptions,
  type AddPrompter,
  type NoteDecision,
  type NotePreview,
  type UncertainPreview,
  type UncertainResolution,
} from '../src/pipeline.js';

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

function tempVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'learnmate-pipeline-'));
  tempRoots.push(root);
  return vaultPaths(root);
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const TEMPLATE = `你是录入员。\n\n已有标签词表：\n${TAG_VOCABULARY_PLACEHOLDER}\n\n只输出 JSON。`;
const INPUT = '素材加边缘光：抠出发光部分，加 乙插件。';
const OTHER_INPUT = '把三层素材嵌套工程：底层模糊、中层主体、顶层边缘光。';

/**
 * 可控的 id 生成器：`prefix` 给 24 个字符，后面补两位计数，正好 26 位。
 *
 * 前缀之所以要可变，是为了造出重名守卫的两种撞名情形：**同一批**里 id8 相同（同前缀），
 * 以及 `--force` 重跑时新旧 id8 不同（换前缀里的第 8 个字符）。
 */
function idFactory(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}${String(count).padStart(2, '0')}`;
  };
}

const PREFIX_A = '01J8ZK4M2Q7V9N3P5R7T9W2X';
const PREFIX_B = '01J8ZK4N2Q7V9N3P5R7T9W2X';
const INPUT_ID = `${PREFIX_A}01`;
const NOTE_ID = `${PREFIX_A}02`;
const NOW = (): Date => new Date('2026-09-28T13:31:26.000Z');

function baseOptions(
  paths: VaultPaths,
  chat: ChatFunction,
  extra: Partial<AddOptions> = {},
): AddOptions {
  return {
    paths,
    template: TEMPLATE,
    model: 'fake-model',
    promptVersion: 'analyze.v1',
    chat,
    maxInputChars: 20_000,
    now: NOW,
    ...extra,
  };
}

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

/** 一次都不该被调用的模型：用来验证「已经处理过了」真的没再花钱。 */
function forbiddenChat(): FakeChat {
  const calls: ChatMessage[][] = [];
  const chat: ChatFunction = (messages) => {
    calls.push(messages.map((message) => ({ ...message })));
    return Promise.reject(new Error('这个用例里不该调用模型'));
  };
  return { chat, calls };
}

interface NoteSpec {
  title: string;
  summary?: string;
  tags?: string[];
  blocks?: unknown[];
}

/** 拼一份合法的模型回应（能过 `core/validate.ts` 的形状）。 */
function reply(notes: readonly NoteSpec[]): string {
  return JSON.stringify({
    notes: notes.map((note) => ({
      title: note.title,
      summary: note.summary ?? '一句话总结。',
      language: 'zh',
      tags: note.tags ?? ['AE'],
      blocks: note.blocks ?? [{ type: 'text', text: '在阴影的基础上做。' }],
    })),
  });
}

function oneNote(title = '素材加边缘光'): string {
  return reply([{ title }]);
}

/** 收集进度输出，用来断言「有没有把话说清楚」。 */
function collector(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message) => lines.push(message), lines };
}

interface ScriptedPrompter extends AddPrompter {
  notePrompts: NotePreview[];
  uncertainPrompts: UncertainPreview[];
}

/** 按脚本回答的预览实现；脚本用完还在被问就直接炸掉（说明用例写错了）。 */
function scriptedPrompter(script: {
  decisions?: readonly NoteDecision[];
  resolutions?: readonly UncertainResolution[];
}): ScriptedPrompter {
  const decisions = [...(script.decisions ?? [])];
  const resolutions = [...(script.resolutions ?? [])];
  const notePrompts: NotePreview[] = [];
  const uncertainPrompts: UncertainPreview[] = [];

  return {
    notePrompts,
    uncertainPrompts,
    confirmNote(preview) {
      notePrompts.push(preview);
      const decision = decisions.shift();
      if (decision === undefined) throw new Error('脚本里没有更多的笔记回答了');
      return Promise.resolve(decision);
    },
    resolveUncertain(preview) {
      uncertainPrompts.push(preview);
      const resolution = resolutions.shift();
      if (resolution === undefined) throw new Error('脚本里没有更多的存疑回答了');
      return Promise.resolve(resolution);
    },
  };
}

const quiet = (): void => undefined;

/* ------------------------------------------------------------------ *
 * 台账：两种行
 * ------------------------------------------------------------------ */

/**
 * 台账是判别联合（契约 §9.3）：笔记行（`outcome: 'ok'`）才有 `id`/`note_path`/`note_index`，
 * 输入行只有「这次输入怎么了」。所以断言之前先收窄——这是类型系统在替我们记住
 * 「哪些字段不是每条记录都有的」。
 */
function okEntries(paths: VaultPaths): LedgerNoteRow[] {
  return readLedger(paths).entries.filter((e): e is LedgerNoteRow => e.outcome === 'ok');
}

function inputEntries(paths: VaultPaths): LedgerInputRow[] {
  return readLedger(paths).entries.filter((e): e is LedgerInputRow => e.outcome !== 'ok');
}

/** 那次输入的结局。没有历史行时返回 `null`，让断言能说「本来该有一行的」。 */
function inputOutcome(paths: VaultPaths): LedgerInputOutcome | null {
  return inputEntries(paths)[0]?.outcome ?? null;
}

/* ------------------------------------------------------------------ *
 * 顺利写入
 * ------------------------------------------------------------------ */

describe('add：顺利写入', () => {
  it('--yes 全程不问，笔记、台账、原文、草稿各就各位', async () => {
    const paths = tempVault();
    const { chat } = fakeChat([oneNote()]);
    const { log, lines } = collector();

    const code = await runAdd(
      INPUT,
      baseOptions(paths, chat, { yes: true, tags: [], newId: idFactory(PREFIX_A), log }),
    );

    assert.equal(code, EXIT.OK);

    const notes = listNoteFiles(paths);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? '', /素材加边缘光-01j8zk4m\.md$/);

    const markdown = readFileSync(notes[0] ?? '', 'utf8');
    assert.match(markdown, /^---\nid: "?01J8ZK4M2Q7V9N3P5R7T9W2X02"?\n/);
    assert.ok(markdown.includes('> 一句话总结。'), 'summary 渲染成引用块');
    assert.match(markdown, /status: "?inbox"?/, '--yes 写出来的笔记默认是收件箱');
    assert.match(markdown, /schema_version: 1/);
    assert.match(markdown, /source_hash: sha256:[0-9a-f]{64}/);
    assert.match(markdown, /input_id: "?01J8ZK4M2Q7V9N3P5R7T9W2X01"?/);
    assert.ok(!markdown.includes(INPUT), '笔记是整理结果，不是原文的复印件');

    const ledger = readLedger(paths);
    assert.equal(ledger.skippedLines, 0);
    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0];
    assert.equal(entry?.outcome, 'ok');
    assert.equal(entry?.input_id, INPUT_ID);
    assert.equal(entry?.id, NOTE_ID);
    assert.equal(entry?.note_index, 1);
    assert.equal(entry?.note_total, 1);
    assert.equal(entry?.note_path, 'notes/素材加边缘光-01j8zk4m.md');
    assert.deepEqual(entry?.tags, ['AE']);
    assert.equal(entry?.status, 'inbox');
    assert.equal(entry?.model, 'fake-model');
    assert.equal(entry?.prompt_version, 'analyze.v1');
    assert.equal(entry?.tokens_in, 100);
    assert.equal(entry?.tokens_out, 50);
    assert.equal(entry?.latency_ms, 7);
    assert.equal(entry?.ts, formatTimestamp(NOW()));
    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)));
    assert.ok(fileExists(draftFilePath(paths, INPUT_ID)));

    assert.ok(lines.some((line) => line.includes('原文已保存：.learnmate/raw/')));
    assert.ok(lines.some((line) => line.includes('✓ 写入 1 条笔记')));
  });

  it('每条笔记的 id 在预览之前就定好，预览到的文件名与最终一致', async () => {
    const paths = tempVault();
    const { chat } = fakeChat([reply([{ title: '第一条' }, { title: '第二条' }])]);
    const prompter = scriptedPrompter({ decisions: ['write', 'write'] });

    await runAdd(
      INPUT,
      baseOptions(paths, chat, { tags: [], newId: idFactory(PREFIX_A), prompter, log: quiet }),
    );

    const previewed = prompter.notePrompts.map((preview) => preview.markdown);
    const written = listNoteFiles(paths).map((file) => readFileSync(file, 'utf8'));
    assert.deepEqual(written.sort(), previewed.sort(), '预览里看到的那份就是落盘的那份');
  });
});

/* ------------------------------------------------------------------ *
 * 验收点①
 * ------------------------------------------------------------------ */

describe('验收点①：预览按 n 跳过', () => {
  it('notes/ 里没有文件，但 raw/ 与 draft/ 都在', async () => {
    const paths = tempVault();
    const { chat } = fakeChat([oneNote()]);
    const prompter = scriptedPrompter({ decisions: ['skip'] });
    const { log, lines } = collector();

    const code = await runAdd(
      INPUT,
      baseOptions(paths, chat, { tags: [], newId: idFactory(PREFIX_A), prompter, log }),
    );

    assert.equal(code, EXIT.OK, '用户主动跳过不是错误');
    assert.equal(listNoteFiles(paths).length, 0, 'notes/ 里不该有文件');
    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)), '原文必须保留');
    assert.ok(fileExists(draftFilePath(paths, INPUT_ID)), '草稿必须保留（之后还能 reprocess）');
    assert.equal(okEntries(paths).length, 0, '全部跳过就没有笔记行');
    // 但「这次输入怎么了」要记下来：用户的决定也是一种结局（契约 §9.3 出口 8）。
    assert.equal(inputOutcome(paths), 'skipped');
    assert.equal(inputEntries(paths)[0]?.draft_total, 1);
    assert.equal(inputEntries(paths)[0]?.skipped_total, 1);
    assert.ok(lines.some((line) => line.includes('跳过 1 条')));
  });
});

/* ------------------------------------------------------------------ *
 * 验收点②
 * ------------------------------------------------------------------ */

describe('验收点②：--dry-run 一个文件都不写', () => {
  it('跑完整个流程，知识库目录仍然是空的', async () => {
    const paths = tempVault();
    const { chat, calls } = fakeChat([oneNote()]);
    const { log, lines } = collector();

    const code = await runAdd(
      INPUT,
      baseOptions(paths, chat, { yes: true, tags: [], dryRun: true, newId: idFactory(PREFIX_A), log }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(calls.length, 1, '--dry-run 仍然要调用模型，不然没有东西可预览');
    assert.deepEqual(readdirSync(paths.root), [], '知识库根目录下不该有任何东西');
    assert.ok(lines.some((line) => line.includes('本来会写入 1 条笔记')));
  });
});

/* ------------------------------------------------------------------ *
 * 验收点③
 * ------------------------------------------------------------------ */

describe('验收点③：重复输入与 --force', () => {
  it('同一份内容再贴一次：提示处理过、退出 0、不再调用模型、不多写东西', async () => {
    const paths = tempVault();
    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        yes: true,
        tags: [],
        newId: idFactory(PREFIX_A),
        log: quiet,
      }),
    );

    const { log, lines } = collector();
    const second = forbiddenChat();
    const code = await runAdd(
      INPUT,
      baseOptions(paths, second.chat, { yes: true, tags: [], newId: idFactory(PREFIX_B), log }),
    );

    assert.equal(code, EXIT.OK, '「已经处理过」不是错误');
    assert.equal(second.calls.length, 0, '不该再花一次钱');
    assert.ok(
      lines.some((line) => line.includes('这份输入已于') && line.includes('产出 1 条笔记')),
      '要说清楚什么时候处理过、产出几条',
    );
    assert.ok(lines.some((line) => line.includes('--force')));
    assert.equal(listNoteFiles(paths).length, 1);
    assert.equal(readLedger(paths).entries.length, 1);
    assert.equal(readdirSync(paths.rawDir).length, 1, '不该多写一份原文');
  });

  it('--force：新笔记用新 id，旧笔记逐字符不变', async () => {
    const paths = tempVault();
    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        yes: true,
        tags: [],
        newId: idFactory(PREFIX_A),
        log: quiet,
      }),
    );
    const before = readFileSync(noteFilePath(paths, '素材加边缘光', NOTE_ID), 'utf8');

    const second = fakeChat([oneNote()]);
    const code = await runAdd(
      INPUT,
      baseOptions(paths, second.chat, {
        yes: true,
        tags: [],
        force: true,
        newId: idFactory(PREFIX_B),
        log: quiet,
      }),
    );

    assert.equal(code, EXIT.OK);
    const notes = listNoteFiles(paths).map((file) => file.split(/[\\/]/).pop() ?? '');
    assert.equal(notes.length, 2, '两次产出的是两个文件，不是覆盖');
    assert.ok(notes.some((name) => name === '素材加边缘光-01j8zk4m.md'));
    assert.ok(notes.some((name) => name === '素材加边缘光-01j8zk4n.md'));
    assert.equal(
      readFileSync(noteFilePath(paths, '素材加边缘光', NOTE_ID), 'utf8'),
      before,
      '旧笔记必须原样留着',
    );

    const ledger = okEntries(paths);
    assert.equal(ledger.length, 2, '两次各记一行');
    assert.notEqual(ledger[0]?.id, ledger[1]?.id);
  });
});

/* ------------------------------------------------------------------ *
 * 验收点④（TD8）
 * ------------------------------------------------------------------ */

describe('验收点④：写入前的重名守卫（TD8）', () => {
  it('两个标题不同、算出来的文件名相同：一条都不写，只留下原文和草稿', async () => {
    const paths = tempVault();
    // 标题不相等（完全相同的标题会被 core/validate.ts 先拦下），但 slug 一样——
    // 这正是文件名规则挡不住的那个缺口：同批笔记的 id 前 8 位必然相同。
    const { chat } = fakeChat([reply([{ title: '工具 设置' }, { title: '工具_设置' }])]);
    const { log, lines } = collector();

    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(paths, chat, { yes: true, tags: [], newId: idFactory(PREFIX_A), log }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UnsafeWriteError, '应该是 UnsafeWriteError');
        assert.equal(error.exitCode, EXIT.VALIDATION, '退出码 3');
        assert.match(error.message, /一条都没有写入/);
        assert.match(error.message, /工具-设置-01j8zk4m\.md/, '要点名是哪个文件');
        assert.match(error.message, /工具 设置/);
        assert.match(error.message, /工具_设置/);
        return true;
      },
    );

    assert.equal(listNoteFiles(paths).length, 0, '整批都不写，不留半个批次');
    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)), '原文还在');
    assert.ok(fileExists(draftFilePath(paths, INPUT_ID)), '草稿还在');
    assert.equal(okEntries(paths).length, 0, '整批不写 = 一行笔记行都没有');
    assert.equal(inputOutcome(paths), 'unsafe_write');
    assert.equal(inputEntries(paths)[0]?.draft_total, 2);
    assert.ok(lines.some((line) => line.includes('拆分为 2 条笔记')));
  });

  it('两个标题只差大小写也算撞名（Windows 和 macOS 的文件系统不区分大小写）', async () => {
    const paths = tempVault();
    const { chat } = fakeChat([reply([{ title: 'Tool' }, { title: 'tool' }])]);
    const { log } = collector();
    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(paths, chat, { yes: true, tags: [], newId: idFactory(PREFIX_A), log }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UnsafeWriteError, '应该是 UnsafeWriteError');
        assert.equal(error.exitCode, EXIT.VALIDATION, '退出码 3');
        assert.match(error.message, /一条都没有写入/);
        return true;
      },
    );

    assert.equal(listNoteFiles(paths).length, 0);
  });

  it('磁盘上已经有同名文件时也要拦（否则 --force 会把上一次的结果盖掉）', async () => {
    const paths = tempVault();
    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        yes: true,
        tags: [],
        newId: idFactory(PREFIX_A),
        log: quiet,
      }),
    );

    // 换一份内容（指纹不同，所以不会被查重拦住），但 id 前缀一样 —— 文件名就会撞。
    const second = fakeChat([oneNote()]);
    await assert.rejects(
      runAdd(
        OTHER_INPUT,
        baseOptions(paths, second.chat, {
          yes: true,
          tags: [],
          newId: idFactory(PREFIX_A),
          log: quiet,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UnsafeWriteError);
        assert.match(error.message, /知识库里已经有这个文件了/);
        return true;
      },
    );


    assert.equal(listNoteFiles(paths).length, 1, '还是只有第一次那一条');
  });
});

/* ------------------------------------------------------------------ *
 * 验收点⑤
 * ------------------------------------------------------------------ */

describe('验收点⑤：校验重试耗尽', () => {
  const BAD = JSON.stringify({
    notes: [
      { title: '', summary: '一句话总结。', language: 'zh', tags: ['AE'], blocks: [{ type: 'text', text: '一段话。' }] },
    ],
  });

  it('原文与模型的每一次原始产出都留着，现场进 quarantine/，错误是退出码 3', async () => {
    const paths = tempVault();
    const { chat, calls } = fakeChat([BAD]);
    const { log, lines } = collector();

    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(paths, chat, {
          yes: true,
          tags: [],
          newId: idFactory(PREFIX_A),
          log,
          maxRetries: 0,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError, '应该是 ValidationError');
        assert.equal(error.exitCode, EXIT.VALIDATION);
        assert.equal(error.attempts, 1);
        return true;
      },
    );

    assert.equal(calls.length, 1);
    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)), '原文必须已经落盘');
    assert.equal(listNoteFiles(paths).length, 0);
    assert.equal(okEntries(paths).length, 0);
    // 校验失败也是一次真实发生过的输入：原文在，台账里就必须有它的行（契约 §9.3）。
    assert.equal(inputOutcome(paths), 'validation_failed');
    assert.equal(inputEntries(paths)[0]?.draft_total, 0);

    const scenePath = quarantineFilePath(paths, INPUT_ID);
    assert.ok(fileExists(scenePath), '现场必须留下来，否则没人知道模型回了什么');
    const scene = JSON.parse(readFileSync(scenePath, 'utf8')) as {
      input_id: string;
      source_hash: string;
      model: string;
      prompt_version: string;
      attempts: number;
      raw_outputs: string[];
      message: string;
    };
    assert.equal(scene.input_id, INPUT_ID);
    assert.match(scene.source_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(scene.model, 'fake-model');
    assert.equal(scene.prompt_version, 'analyze.v1');
    assert.equal(scene.attempts, 1);
    assert.deepEqual(scene.raw_outputs, [BAD]);
    assert.match(scene.message, /不合契约/);
    assert.ok(lines.some((line) => line.includes('现场已保存：')));
  });

  it('--dry-run 时连现场都不写', async () => {
    const paths = tempVault();
    const { chat } = fakeChat([BAD]);

    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(paths, chat, {
          yes: true,
          tags: [],
          dryRun: true,
          newId: idFactory(PREFIX_A),
          log: quiet,
          maxRetries: 0,
        }),
      ),
      ValidationError,
    );

    assert.deepEqual(readdirSync(paths.root), [], '--dry-run 的承诺是一个字节都不写');
  });
});

/* ------------------------------------------------------------------ *
 * 存疑项裁定
 * ------------------------------------------------------------------ */

describe('存疑项：先问存疑，再问要不要写', () => {
  const UNCERTAIN = '导出清晰：尺寸选择 4K，等比例放大';
  const REASON = '4K 指合成尺寸还是导出尺寸，原文没有说明';

  function uncertainReply(): string {
    return reply([
      {
        title: '导出清晰',
        blocks: [
          { type: 'text', text: '背景模糊。' },
          { type: 'uncertain', items: [{ text: UNCERTAIN, reason: REASON }] },
        ],
      },
    ]);
  }

  it('k 保留：写进文末的「待确认」，台账记 total=1 / kept=1', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'keep' }],
    });

    const code = await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([uncertainReply()]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log: quiet,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(prompter.uncertainPrompts.length, 1, '存疑项必须被问到');
    assert.equal(prompter.uncertainPrompts[0]?.item.reason, REASON);
    assert.equal(prompter.uncertainPrompts[0]?.total, 1);
    assert.equal(prompter.uncertainPrompts[0]?.index, 1);
    assert.deepEqual(prompter.notePrompts[0]?.draft.blocks.at(-1), {
      type: 'uncertain',
      items: [{ text: UNCERTAIN, reason: REASON }],
    });

    const markdown = readFileSync(noteFilePath(paths, '导出清晰', NOTE_ID), 'utf8');
    assert.ok(markdown.includes('## 待确认'));
    assert.ok(markdown.includes(`- ${UNCERTAIN}`));
    assert.ok(markdown.includes(`存疑原因：${REASON}`));
    assert.match(markdown, /status: "?processed"?/, '交互确认过的笔记是已处理');

    const entry = okEntries(paths)[0];
    assert.equal(entry?.uncertain_total, 1);
    assert.equal(entry?.uncertain_kept, 1);
    assert.equal(entry?.status, 'processed');
  });

  it('d 删除：笔记里没有「待确认」这一节，kept=0', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'drop' }],
    });

    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([uncertainReply()]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log: quiet,
      }),
    );

    const markdown = readFileSync(noteFilePath(paths, '导出清晰', NOTE_ID), 'utf8');
    assert.ok(!markdown.includes('## 待确认'));
    assert.ok(!markdown.includes(UNCERTAIN));

    const entry = okEntries(paths)[0];
    assert.equal(entry?.uncertain_total, 1);
    assert.equal(entry?.uncertain_kept, 0);
  });

  it('e 改写：用户的更正写进「更正为：」，kept=1', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'edit', text: '4K 指导出尺寸。' }],
    });

    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([uncertainReply()]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log: quiet,
      }),
    );

    const markdown = readFileSync(noteFilePath(paths, '导出清晰', NOTE_ID), 'utf8');
    assert.ok(markdown.includes('更正为：4K 指导出尺寸。'));

    const entry = okEntries(paths)[0];
    assert.equal(entry?.uncertain_kept, 1);
  });

  it('磁盘上的草稿保持模型原样——裁定另存 resolutions/，草稿一个字节都不动', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'edit', text: '4K 指导出尺寸。' }],
    });

    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([uncertainReply()]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log: quiet,
      }),
    );

    const draft = readDraft(paths, INPUT_ID);
    assert.ok(!draft.includes('4K 指导出尺寸。'), '草稿是「模型回了什么」的证据，不该被改写');
    assert.ok(draft.includes(REASON));

    // 用户改了什么，另存一份文件（D40）。这条路才是 reprocess 重放裁定的依据。
    const raw = readResolutions(paths, INPUT_ID);
    const file = JSON.parse(raw) as {
      input_id: string;
      ts: string;
      notes: { note_index: number; items: unknown[] }[];
    };
    assert.equal(file.input_id, INPUT_ID);
    assert.equal(file.ts, formatTimestamp(NOW()));
    assert.deepEqual(file.notes, [
      {
        note_index: 1,
        items: [{ item_index: 1, text: UNCERTAIN, action: 'edit', resolution: '4K 指导出尺寸。' }],
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * TD12：裁定落盘（resolutions/）
 *
 * 用户当年在预览里答的 d / e 只活在内存里，重渲染时会整批丢掉。这一组就是
 * 「已经还上了」的证据：只有**非 keep** 的裁定才写文件，草稿照旧一个字节不动。
 * ------------------------------------------------------------------ */

describe('裁定落盘：只有非 keep 才写 resolutions/（还 TD12）', () => {
  const UNCERTAIN = '导出清晰：尺寸选择 4K，等比例放大';
  const REASON = '4K 指合成尺寸还是导出尺寸，原文没有说明';

  function uncertainReply(): string {
    return reply([
      {
        title: '导出清晰',
        blocks: [
          { type: 'text', text: '背景模糊。' },
          { type: 'uncertain', items: [{ text: UNCERTAIN, reason: REASON }] },
        ],
      },
    ]);
  }

  function addOptions(
    paths: VaultPaths,
    prompter: AddPrompter,
    extra: Partial<AddOptions> = {},
  ): AddOptions {
    return baseOptions(paths, fakeChat([uncertainReply()]).chat, {
      tags: [],
      newId: idFactory(PREFIX_A),
      prompter,
      log: quiet,
      ...extra,
    });
  }

  function readResolutionFile(paths: VaultPaths): {
    input_id: string;
    notes: { note_index: number; items: Record<string, unknown>[] }[];
  } {
    return JSON.parse(readResolutions(paths, INPUT_ID)) as {
      input_id: string;
      notes: { note_index: number; items: Record<string, unknown>[] }[];
    };
  }

  it('答 d：落盘的是 action=drop，且不带 resolution', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'drop' }],
    });

    await runAdd(INPUT, addOptions(paths, prompter));

    const file = readResolutionFile(paths);
    assert.deepEqual(file.notes, [
      { note_index: 1, items: [{ item_index: 1, text: UNCERTAIN, action: 'drop' }] },
    ]);
  });

  it('答 e：落盘的 resolution 就是用户那句话', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'edit', text: '指导出尺寸。' }],
    });

    await runAdd(INPUT, addOptions(paths, prompter));

    const file = readResolutionFile(paths);
    assert.equal(file.notes[0]?.items[0]?.resolution, '指导出尺寸。');
    assert.equal(file.notes[0]?.items[0]?.action, 'edit');
  });

  it('一条 drop 一条 edit：两条都记，item_index 与在草稿里的顺序一致', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'drop' }, { action: 'edit', text: '第二条的更正。' }],
    });

    const twoUncertain = reply([
      {
        title: '导出清晰',
        blocks: [
          { type: 'text', text: '背景模糊。' },
          {
            type: 'uncertain',
            items: [
              { text: '第一条存疑', reason: '原因一' },
              { text: '第二条存疑', reason: '原因二' },
            ],
          },
        ],
      },
    ]);

    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([twoUncertain]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log: quiet,
      }),
    );

    const file = readResolutionFile(paths);
    assert.deepEqual(file.notes, [
      {
        note_index: 1,
        items: [
          { item_index: 1, text: '第一条存疑', action: 'drop' },
          { item_index: 2, text: '第二条存疑', action: 'edit', resolution: '第二条的更正。' },
        ],
      },
    ]);
  });

  it('全 k：一个字节都不写（keep 是默认值）', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'keep' }],
    });

    await runAdd(INPUT, addOptions(paths, prompter));

    assert.equal(fileExists(resolutionFilePath(paths, INPUT_ID)), false);
    assert.deepEqual(listResolutionFiles(paths), []);
  });

  it('--yes：不问存疑项，也不产生裁定文件', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({});

    await runAdd(INPUT, addOptions(paths, prompter, { yes: true }));

    assert.equal(prompter.uncertainPrompts.length, 0);
    assert.equal(fileExists(resolutionFilePath(paths, INPUT_ID)), false);
  });

  it('--dry-run：裁定文件不写，但会说明本来要写', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write'],
      resolutions: [{ action: 'drop' }],
    });
    const { log, lines } = collector();

    const code = await runAdd(INPUT, addOptions(paths, prompter, { dryRun: true, log }));

    assert.equal(code, EXIT.OK);
    assert.equal(fileExists(resolutionFilePath(paths, INPUT_ID)), false);
    assert.ok(lines.some((line) => line.includes('resolutions/')));
  });

  it('用户 q 取消整批：裁定文件不写（笔记也一条没写）', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['quit'],
      resolutions: [{ action: 'drop' }],
    });

    const code = await runAdd(INPUT, addOptions(paths, prompter));

    assert.equal(code, EXIT.OK);
    assert.equal(fileExists(resolutionFilePath(paths, INPUT_ID)), false);
    assert.deepEqual(listNoteFiles(paths), []);
  });

  it('用户答 n 跳过这条笔记：裁定照样落盘（下次 reprocess 才能重放）', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['skip'],
      resolutions: [{ action: 'edit', text: '跳过了但改了。' }],
    });

    await runAdd(INPUT, addOptions(paths, prompter));

    assert.deepEqual(listNoteFiles(paths), []);
    const file = readResolutionFile(paths);
    assert.equal(file.notes[0]?.items[0]?.resolution, '跳过了但改了。');
  });

  it('多篇笔记：note_index 是草稿里 1 起的下标，只记有非 keep 的那几篇', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({
      decisions: ['write', 'write'],
      resolutions: [{ action: 'keep' }, { action: 'drop' }],
    });

    const twoNotes = reply([
      {
        title: '第一篇',
        blocks: [
          { type: 'text', text: '正文一。' },
          { type: 'uncertain', items: [{ text: '第一篇的存疑', reason: '原因一' }] },
        ],
      },
      {
        title: '第二篇',
        blocks: [
          { type: 'text', text: '正文二。' },
          { type: 'uncertain', items: [{ text: '第二篇的存疑', reason: '原因二' }] },
        ],
      },
    ]);

    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([twoNotes]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log: quiet,
      }),
    );

    const file = readResolutionFile(paths);
    assert.deepEqual(file.notes, [
      { note_index: 2, items: [{ item_index: 1, text: '第二篇的存疑', action: 'drop' }] },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 其他边界
 * ------------------------------------------------------------------ */

describe('退出（q）：整批都不写', () => {
  it('第一条答 y、第二条答 q：notes/ 仍然是空的', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({ decisions: ['write', 'quit'] });
    const { log, lines } = collector();

    const code = await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([reply([{ title: '第一条' }, { title: '第二条' }])]).chat, {
        tags: [],
        newId: idFactory(PREFIX_A),
        prompter,
        log,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(prompter.notePrompts.length, 2);
    assert.equal(listNoteFiles(paths).length, 0, '半途而废的批次比一条都不写更难收拾');
    assert.equal(okEntries(paths).length, 0);
    // 取消是退出码 0，也是一次真实发生过的输入 —— 不写这行，它就变成 T11 捡到的那个孤儿。
    assert.equal(inputOutcome(paths), 'cancelled');
    assert.equal(inputEntries(paths)[0]?.draft_total, 2, '取消前模型产出了 2 条草稿');
    assert.equal(inputEntries(paths)[0]?.skipped_total, 0);
    assert.ok(lines.some((line) => line.includes('已取消')));
    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)));
    assert.ok(fileExists(draftFilePath(paths, INPUT_ID)));
  });
});

describe('全部接受（a）', () => {
  it('按一次 a，后面的笔记不再问，台账按顺序记全', async () => {
    const paths = tempVault();
    const prompter = scriptedPrompter({ decisions: ['accept-all'] });

    await runAdd(
      INPUT,
      baseOptions(
        paths,
        fakeChat([reply([{ title: '第一条' }, { title: '第二条' }, { title: '第三条' }])]).chat,
        { tags: [], newId: idFactory(PREFIX_A), prompter, log: quiet },
      ),
    );

    assert.equal(prompter.notePrompts.length, 1, 'a 之后不该再问');
    assert.equal(listNoteFiles(paths).length, 3);
    const entries = okEntries(paths);
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((entry) => entry.note_index),
      [1, 2, 3],
    );
    assert.equal(entries[0]?.note_total, 3);
  });
});

describe('0 条笔记（契约 4.1）', () => {
  it('不写笔记，但记一行 empty，退出 0，并告诉用户原文在哪', async () => {
    const paths = tempVault();
    const { log, lines } = collector();

    const code = await runAdd(
      INPUT,
      baseOptions(paths, fakeChat(['{"notes": []}']).chat, {
        yes: true,
        tags: [],
        newId: idFactory(PREFIX_A),
        log,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(readdirSync(paths.notesDir).length, 0);
    assert.equal(okEntries(paths).length, 0);
    // 「模型说没有可整理的」和「用户跳过」是两件事，所以它有自己的 outcome。
    // T11 捡到的那个孤儿现场（draft 里是 {"notes": []}、台账一行都没有）就是这里留下的。
    assert.equal(inputOutcome(paths), 'empty');
    assert.equal(inputEntries(paths)[0]?.draft_total, 0);
    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)), '原文还是要留着');
    assert.ok(fileExists(draftFilePath(paths, INPUT_ID)), '草稿也留着：它就是「模型说没有」的证据');
    assert.ok(lines.some((line) => line.includes('这次没有可整理的笔记')));
  });
});

describe('输入超长：用法错误，一个字节都不写', () => {
  it('抛 UsageError（退出码 2），并且一次模型都没调', async () => {
    const paths = tempVault();
    const { chat, calls } = fakeChat([oneNote()]);

    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(paths, chat, { yes: true, tags: [], maxInputChars: 5, newId: idFactory(PREFIX_A) }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.equal(error.exitCode, EXIT.USAGE);
        return true;
      },
    );

    assert.equal(calls.length, 0, '超长就该在发请求之前停住');
    assert.deepEqual(readdirSync(paths.root), []);
  });
});

describe('标签词表：从笔记本身取（D36）', () => {
  it('第二批输入的提示词里能看到第一批用过的标签', async () => {
    const paths = tempVault();
    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        yes: true,
        tags: [],
        newId: idFactory(PREFIX_A),
        log: quiet,
      }),
    );

    // 不再显式传 tags：pipeline 应该自己去 notes/ 里找第一批留下的标签。
    const second = fakeChat([oneNote('第二条')]);
    await runAdd(
      OTHER_INPUT,
      baseOptions(paths, second.chat, { yes: true, newId: idFactory(PREFIX_B), log: quiet }),
    );

    const system = second.calls[0]?.[0]?.content ?? '';
    assert.ok(system.includes('- AE'), '第一批用过的标签要出现在词表里');
    assert.ok(!system.includes('{{'), '不能把裸露的占位符发出去');
  });

  it('台账整个删掉，第二批的提示词里照样有第一批的标签', async () => {
    const paths = tempVault();
    await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        yes: true,
        tags: [],
        newId: idFactory(PREFIX_A),
        log: quiet,
      }),
    );

    // 契约 §9 与 docs/05-recovery.md 都允许用户这么干。词表不该跟着消失。
    rmSync(paths.ledgerFile);
    assert.ok(!fileExists(paths.ledgerFile), '前置条件：台账真的没了');

    const second = fakeChat([oneNote('第二条')]);
    await runAdd(
      OTHER_INPUT,
      baseOptions(paths, second.chat, { yes: true, newId: idFactory(PREFIX_B), log: quiet }),
    );

    const system = second.calls[0]?.[0]?.content ?? '';
    assert.ok(system.includes('- AE'), '笔记还在，标签就该还在');
  });
});

describe('formatTimestamp：给人看的本地时间', () => {
  it('带时区偏移、秒精度，而且指向同一个时刻', () => {
    const stamp = formatTimestamp(new Date('2026-09-28T13:31:26.000Z'));
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.ok(!stamp.endsWith('Z'), '不要 UTC 的 Z 结尾——用户在本地时间线上找笔记');
    assert.equal(new Date(stamp).getTime(), Date.parse('2026-09-28T13:31:26.000Z'));
  });
});

/* ------------------------------------------------------------------ *
 * 验收点⑥（T11）：每一次走过「原文已落盘」的输入，都要在台账里留下结局
 * ------------------------------------------------------------------ */

describe('调模型失败（退出码 4）', () => {
  it('原文已落盘，台账补一行 llm_error，退出码 4', async () => {
    const paths = tempVault();
    const { log } = collector();
    const chat: ChatFunction = () =>
      Promise.reject(new LlmError('模型服务返回了 401。', { status: 401 }));

    await assert.rejects(
      runAdd(INPUT, baseOptions(paths, chat, { yes: true, tags: [], newId: idFactory(PREFIX_A), log })),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.exitCode, EXIT.LLM);
        return true;
      },
    );

    assert.ok(fileExists(rawFilePath(paths, INPUT_ID)), '原文必须已经落盘');
    assert.equal(okEntries(paths).length, 0);
    assert.equal(inputOutcome(paths), 'llm_error');
    assert.equal(inputEntries(paths)[0]?.draft_total, 0, '一次都没答上来');
    assert.equal(inputEntries(paths)[0]?.skipped_total, undefined, '没跳过任何东西，就别造这个字段');
  });

  it('reason 里不许出现 API Key —— 台账是一份会被复制出去的文件', async () => {
    const bearer = tempVault();
    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(
          bearer,
          () =>
            Promise.reject(
              new LlmError('模型服务返回了 401：Bearer sk-live-0123456789abcdef 无效。', {
                status: 401,
              }),
            ),
          { yes: true, tags: [], newId: idFactory(PREFIX_A), log: quiet },
        ),
      ),
    );

    const bearerReason = inputEntries(bearer)[0]?.reason ?? '';
    assert.ok(!bearerReason.includes('sk-live-0123456789abcdef'), '密钥不能躺在磁盘上');
    assert.ok(!bearerReason.includes('Bearer sk-live'), '整个令牌都要抹掉');
    assert.ok(bearerReason.includes('Bearer [已隐去]'), '连 `Bearer` 一起换成占位符');

    // 单说一个 `sk-` 开头的令牌（没有 `Bearer` 前缀）也要抹掉。
    const bare = tempVault();
    await assert.rejects(
      runAdd(
        INPUT,
        baseOptions(
          bare,
          () => Promise.reject(new LlmError('这个 Key 被拒绝了：sk-live-0123456789abcdef')),
          { yes: true, tags: [], newId: idFactory(PREFIX_A), log: quiet },
        ),
      ),
    );

    const bareReason = inputEntries(bare)[0]?.reason ?? '';
    assert.ok(!bareReason.includes('sk-live-0123456789abcdef'));
    assert.ok(bareReason.includes('[已隐去的 Key]'));
  });
});

describe('--dry-run 与台账', () => {
  it('把「本来会记的那一行」说出来，并且一个字节都不写', async () => {
    const paths = tempVault();
    const { log, lines } = collector();
    const prompter = scriptedPrompter({ decisions: ['skip'] });

    const code = await runAdd(
      INPUT,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        tags: [],
        dryRun: true,
        newId: idFactory(PREFIX_A),
        prompter,
        log,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.deepEqual(readdirSync(paths.root), [], '连目录都不建，更别说台账');
    assert.ok(
      lines.some((line) => line.includes('（--dry-run）本来会往台账里记一行：skipped')),
      '要告诉用户「真实跑一次会多出什么」，否则 --dry-run 就骗人了',
    );
  });

  it('0 条笔记时也一样：说明本来会记一行 empty', async () => {
    const paths = tempVault();
    const { log, lines } = collector();

    const code = await runAdd(
      INPUT,
      baseOptions(paths, fakeChat(['{"notes": []}']).chat, {
        yes: true,
        tags: [],
        dryRun: true,
        newId: idFactory(PREFIX_A),
        log,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.deepEqual(readdirSync(paths.root), []);
    assert.ok(lines.some((line) => line.includes('（--dry-run）本来会往台账里记一行：empty')));
  });
});

describe('失败不许掩盖失败', () => {
  it('台账写不进去时，只出声警告，不改写原来的结局', async () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    // 让台账**读得出来、写不进去**：先建一个空文件，再把写权限去掉。
    // 故意不用「把 ledger.jsonl 变成一个目录」这招：那样开头的查重（readText）会先炸，
    // 测到的就不是「追加失败」，而是整个 runAdd 早在第一步就崩了。
    writeFileSync(paths.ledgerFile, '');
    chmodSync(paths.ledgerFile, 0o444);

    const { log, lines } = collector();

    try {
      const code = await runAdd(
        INPUT,
        baseOptions(paths, fakeChat(['{"notes": []}']).chat, {
          yes: true,
          tags: [],
          newId: idFactory(PREFIX_A),
          log,
        }),
      );

      assert.equal(code, EXIT.OK, '记不上账是小事，不能把「模型说没有可整理的」变成崩溃');
      assert.ok(
        lines.some((line) => line.includes('台账没能记下这次输入的结局')),
        '必须出声：静默少一行就是在制造 T11 要修的那个问题',
      );
      assert.ok(lines.some((line) => line.includes('这次输入本身没有受影响')));
    } finally {
      // Windows 上删不掉只读文件，先把权限还回去，免得临时目录清不掉。
      chmodSync(paths.ledgerFile, 0o644);
    }
  });
});

describe('不变量：原文落盘了，台账里就必须有它的行（契约 §9.3）', () => {
  it('五种结局各跑一遍，raw/ 里每个 input_id 都能在台账里找到', async () => {
    const paths = tempVault();
    // 24 字符前缀 + idFactory 的两字符序号 = 26 字符的合法 ULID。
    const base = '01J8ZK4M2Q7V9N3P5R7T9W2';
    const prefix = (n: number): string => `${base}${'23456'[n] ?? '7'}`;
    const withInput = (text: string, index: number) => ({
      yes: true,
      tags: [],
      newId: idFactory(prefix(index)),
      log: quiet,
    });

    // ① 正常写入
    await runAdd(`${INPUT}\n第一遍`, baseOptions(paths, fakeChat([oneNote()]).chat, withInput('a', 0)));
    // ② 模型说没有可整理的
    await runAdd(`${INPUT}\n第二遍`, baseOptions(paths, fakeChat(['{"notes": []}']).chat, withInput('b', 1)));
    // ③ 用户取消
    await runAdd(
      `${INPUT}\n第三遍`,
      baseOptions(paths, fakeChat([oneNote()]).chat, {
        tags: [],
        newId: idFactory(prefix(2)),
        prompter: scriptedPrompter({ decisions: ['quit'] }),
        log: quiet,
      }),
    );
    // ④ 校验重试耗尽
    await assert.rejects(
      runAdd(
        `${INPUT}\n第四遍`,
        baseOptions(paths, fakeChat(['{"notes": "不是数组"}']).chat, {
          ...withInput('d', 3),
          maxRetries: 0,
        }),
      ),
    );
    // ⑤ 调用模型失败
    await assert.rejects(
      runAdd(
        `${INPUT}\n第五遍`,
        baseOptions(
          paths,
          () => Promise.reject(new LlmError('网络不通。')),
          withInput('e', 4),
        ),
      ),
    );

    const rawIds = readdirSync(paths.rawDir).map((name) => name.replace(/\.txt$/, ''));
    assert.equal(rawIds.length, 5, '五次输入，五份原文');

    const ledgerIds = new Set(readLedger(paths).entries.map((entry) => entry.input_id));
    for (const id of rawIds) {
      assert.ok(ledgerIds.has(id), `raw/${id}.txt 在台账里一行都没有——这就是 T11 捡到的孤儿`);
    }
    assert.deepEqual(
      inputEntries(paths).map((entry) => entry.outcome).sort(),
      ['cancelled', 'empty', 'llm_error', 'validation_failed'],
    );
  });
});
