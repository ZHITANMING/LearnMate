/**
 * `learnmate reprocess` 的测试。
 *
 * 分三层：
 *   1. `mapDraftNotes` / `listCandidates` / `checkPlanTargets` 是纯函数，直接喂对象、断结果；
 *   2. `runReprocess` 走真的临时知识库，测那些纯函数测不到的事——**逐字节幂等**、
 *      裁定重放、撞名守卫、dry-run 一个字节都不写；
 *   3. `runReprocessCommand` 走真配置文件，测退出码与「候选摊开、绝不猜」。
 *
 * 全程用临时目录造知识库：真实 `vault/` 里那 28 篇笔记是用户的资产，测试一行都不碰。
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NoteDraft, NoteFrontmatter, NoteStatus } from '../src/core/contracts.js';
import { EXIT, LearnMateError } from '../src/core/errors.js';
import type { ExitCode } from '../src/core/errors.js';
import { renderNote } from '../src/core/render.js';
import {
  checkPlanTargets,
  listCandidates,
  mapDraftNotes,
  type MapDraftNotesInput,
} from '../src/core/reprocess.js';
import { appendEntries } from '../src/io/ledger.js';
import {
  draftFilePath,
  ensureVaultLayout,
  fileExists,
  listResolutionFiles,
  noteFilePath,
  rawFilePath,
  readResolutions,
  readText,
  resolutionFilePath,
  vaultPaths,
  writeDraft,
  writeNote,
  writeResolutions,
  writeTextAtomic,
  type VaultPaths,
} from '../src/io/vault.js';
import {
  formatTimestamp,
  runReprocess,
  type NoteDecision,
  type ReprocessPrompter,
  type UncertainResolution,
} from '../src/pipeline.js';
import { runReprocessCommand, type ReprocessCommandOptions } from '../src/commands/reprocess.js';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const root = mkdtempSync(join(tmpdir(), 'learnmate-reprocess-'));
after(() => rmSync(root, { recursive: true, force: true }));

let vaultCounter = 0;
function freshVault(): VaultPaths {
  vaultCounter += 1;
  const paths = vaultPaths(join(root, `vault-${String(vaultCounter)}`));
  ensureVaultLayout(paths);
  return paths;
}

const HASH_A = 'sha256:5c095fff4ead54ecaf98f10d32c063df53cea3a41e298db70abd5a14d6f65cfb';
const HASH_B = 'sha256:57fc9a4e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6';
const CREATED = '2026-09-29T13:06:20+08:00';

/** 固定 26 字符、ULID 字符集之内（不含 I/L/O/U）。 */
function ulid(n: number): string {
  return `01J8ZK4M2Q7V9N3P5R7T9W2X${n.toString(36).toUpperCase().padStart(2, '0')}`;
}

const INPUT_A = ulid(0x10);
const INPUT_B = ulid(0x20);
const NOTE_1 = ulid(0x31);
const NOTE_2 = ulid(0x32);

const NOW = (): Date => new Date('2026-10-01T02:00:00.000Z');
const STAMP = formatTimestamp(NOW());

function draftOf(title: string, text = '正文。'): NoteDraft {
  return {
    title,
    summary: `${title} 的摘要。`,
    language: 'zh',
    tags: ['AE'],
    blocks: [{ type: 'text', text }],
  };
}

interface NoteFields {
  id: string;
  inputId?: string;
  draft: NoteDraft;
  sourceHash?: string;
  model?: string;
  promptVersion?: string;
  status?: NoteStatus;
  created?: string;
  updated?: string;
  sourceRef?: string;
}

/** 按“如果当时是 add 写出来的”那样渲染一篇笔记并落到 notes/。 */
function putNote(paths: VaultPaths, fields: NoteFields): string {
  const created = fields.created ?? CREATED;
  const markdown = renderNote(fields.draft, {
    id: fields.id,
    inputId: fields.inputId ?? INPUT_A,
    created,
    updated: fields.updated ?? created,
    status: fields.status ?? 'processed',
    sourceHash: fields.sourceHash ?? HASH_A,
    ...(fields.sourceRef === undefined ? {} : { sourceRef: fields.sourceRef }),
    schemaVersion: 1,
    model: fields.model ?? 'deepseek-chat',
    promptVersion: fields.promptVersion ?? 'analyze.v1',
  });
  return writeNote(paths, fields.draft.title, fields.id, markdown);
}

interface OkRowFields {
  id: string;
  index: number;
  total: number;
  path: string;
  title: string;
  sourceHash?: string;
  model?: string;
  promptVersion?: string;
}

/** 往台账里追加若干 ok 行（reprocess 默认路径只读它）。 */
function putLedgerRows(paths: VaultPaths, inputId: string, rows: readonly OkRowFields[]): void {
  appendEntries(
    paths,
    rows.map((row) => ({
      ts: CREATED,
      input_id: inputId,
      id: row.id,
      note_index: row.index,
      note_total: row.total,
      source_hash: row.sourceHash ?? HASH_A,
      note_path: row.path,
      title: row.title,
      tags: ['AE'],
      status: 'processed',
      model: row.model ?? 'deepseek-chat',
      prompt_version: row.promptVersion ?? 'analyze.v1',
      tokens_in: 100,
      tokens_out: 50,
      latency_ms: 7,
      uncertain_total: 0,
      uncertain_kept: 0,
      outcome: 'ok' as const,
    })),
  );
}

/**
 * 往台账里追加一行**输入行**（没有笔记行的那种）。
 *
 * 真实的 `01M3PD5P2YBCCR5MYYVX5MWMFQ` 就是这种状态：当年用户按 q 取消了，
 * 台账里只留一行 cancelled，草稿 8 条、盘上一篇笔记都没有。reprocess 要从
 * 这一行拿 source_hash / model / prompt_version。
 */
function putInputRow(
  paths: VaultPaths,
  inputId: string,
  outcome: 'cancelled' | 'empty' | 'validation_failed' = 'cancelled',
  draftTotal = 8,
): void {
  appendEntries(paths, [
    {
      ts: CREATED,
      input_id: inputId,
      source_hash: HASH_A,
      model: 'deepseek-chat',
      prompt_version: 'analyze.v2',
      outcome,
      reason: '测试造的一行。',
      draft_total: draftTotal,
    },
  ]);
}

function collector(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message: string) => lines.push(message), lines };
}

function idFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}${counter.toString(36).toUpperCase().padStart(2, '0')}`;
  };
}

interface PrompterScript {
  decisions?: readonly NoteDecision[];
  rulings?: readonly UncertainResolution[];
}

function scriptedPrompter(script: PrompterScript): ReprocessPrompter & {
  notePrompts: unknown[];
  uncertainPrompts: unknown[];
} {
  const decisions = [...(script.decisions ?? [])];
  const rulings = [...(script.rulings ?? [])];
  const notePrompts: unknown[] = [];
  const uncertainPrompts: unknown[] = [];
  return {
    notePrompts,
    uncertainPrompts,
    confirmNote(preview) {
      notePrompts.push(preview);
      const next = decisions.shift();
      if (next === undefined) throw new Error('脚本里没有更多的笔记回答了');
      return Promise.resolve(next);
    },
    resolveUncertain(preview) {
      uncertainPrompts.push(preview);
      const next = rulings.shift();
      if (next === undefined) throw new Error('脚本里没有更多的存疑回答了');
      return Promise.resolve(next);
    },
  };
}

/** 路径快照：跑完之后用来断言“一个字节都没写”。 */
function snapshotDir(dir: string): string[] {
  if (!fileExists(dir)) return [];
  return readdirSync(dir).sort();
}

function configDirFor(vaultPath: string): string {
  const dir = mkdtempSync(join(root, 'cfg-'));
  writeFileSync(
    join(dir, 'learnmate.config.json'),
    JSON.stringify({ model: 'deepseek-chat', vaultPath }),
    'utf8',
  );
  return dir;
}

interface Captured {
  code: ExitCode;
  out: string;
  err: string;
}

/** 把 stdout / stderr 换成缓冲，并把逃出来的 LearnMateError 翻成退出码（与 main 同款）。 */
async function capture(run: () => Promise<ExitCode>): Promise<Captured> {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), out, err };
  } catch (error) {
    if (error instanceof LearnMateError) {
      err += `\n错误：${error.message}\n`;
      return { code: error.exitCode, out, err };
    }
    throw error;
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function command(options: ReprocessCommandOptions): Promise<Captured> {
  // 默认给一份空环境：默认路径不该需要 API Key，这个断言就藏在每一次调用里。
  return capture(() => runReprocessCommand({ env: {}, ...options }));
}

/* ------------------------------------------------------------------ *
 * 纯函数：配对与计划
 * ------------------------------------------------------------------ */

function existingOf(
  fields: {
    id: string;
    title: string;
    sourceHash?: string;
    created?: string;
    inputId?: string;
  }[],
): { relativePath: string; frontmatter: NoteFrontmatter }[] {
  return fields.map((field) => ({
    relativePath: `notes/${field.title}-${field.id.slice(0, 8).toLowerCase()}.md`,
    frontmatter: {
      id: field.id,
      input_id: field.inputId ?? INPUT_A,
      title: field.title,
      created: field.created ?? CREATED,
      updated: field.created ?? CREATED,
      summary: '摘要。',
      tags: ['AE'],
      status: 'processed',
      source_hash: field.sourceHash ?? HASH_A,
      schema_version: 1,
      language: 'zh',
      model: 'deepseek-chat',
      prompt_version: 'analyze.v1',
    },
  }));
}

function planInput(over: Partial<MapDraftNotesInput> = {}): MapDraftNotesInput {
  return {
    inputId: INPUT_A,
    notes: [draftOf('素材加边缘光')],
    existing: [],
    sourceHash: HASH_A,
    createdFallback: STAMP,
    statusForNew: 'processed',
    newId: idFactory(ulid(0x00).slice(0, 24)),
    ...over,
  };
}

describe('mapDraftNotes —— 靠标题配对，配上对就沿用原 id 与 created', () => {
  it('配上对：existing=true、沿用它原来的 id 与 created、existingPath 指向盘上那篇', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        existing: existingOf([{ id: NOTE_1, title: '素材加边缘光' }]),
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const target = plan.targets[0];
    assert.equal(target?.noteId, NOTE_1);
    assert.equal(target?.created, CREATED);
    assert.equal(target?.existing, true);
    assert.equal(target?.existingPath, `notes/素材加边缘光-${NOTE_1.slice(0, 8).toLowerCase()}.md`);
    assert.equal(target?.existingUpdated, CREATED);
    assert.equal(target?.status, 'processed');
    assert.equal(plan.orphanDraftNotes, 0);
    assert.equal(plan.orphanExisting, 0);
  });

  it('盘上没有：新造一个 id、created 用兜底时间、existing=false', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('盘上没有的标题')],
        ledgerModel: 'deepseek-chat',
        ledgerPromptVersion: 'analyze.v1',
        newId: () => NOTE_2,
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.targets[0]?.noteId, NOTE_2);
    assert.equal(plan.targets[0]?.created, STAMP);
    assert.equal(plan.targets[0]?.existing, false);
    assert.equal(plan.targets[0]?.existingPath, null);
    assert.equal(plan.orphanDraftNotes, 1);
  });

  it('同标题但属于别的 input_id 的笔记不算配对：当新笔记写，绝不覆盖别的输入', () => {
    // 真实数据里 `01M3NR4AMKFP6HMM31WYSTTSSX` 与 `01M3PD5P2YBCCR5MYYVX5MWMFQ`
    // 是同一份原文的两代产出，标题大量重叠。重处理第二代不能把第一代就地改掉。
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        existing: existingOf([{ id: NOTE_1, title: '素材加边缘光', inputId: INPUT_B }]),
        ledgerModel: 'deepseek-chat',
        ledgerPromptVersion: 'analyze.v1',
        newId: () => NOTE_2,
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.targets[0]?.existing, false, '别的输入的笔记不能被当成配对目标');
    assert.equal(plan.targets[0]?.existingPath, null);
    assert.equal(plan.targets[0]?.noteId, NOTE_2);
    assert.equal(plan.orphanDraftNotes, 1);
    assert.equal(plan.orphanExisting, 0, '别的输入的笔记不参与本次统计');
  });

  it('草稿里两条同标题：整批拒绝（ok:false），问题里点名两个序号', () => {
    const plan = mapDraftNotes(
      planInput({ notes: [draftOf('一样的标题'), draftOf('一样的标题')] }),
    );
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.problems.length, 1);
    assert.ok(plan.problems[0]?.includes('第 1 条与第 2 条'), plan.problems.join('\n'));
    assert.ok(plan.problems[0]?.includes('标题一样'), plan.problems.join('\n'));
  });

  it('source_hash 台账优先于既有笔记 frontmatter', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        existing: existingOf([{ id: NOTE_1, title: '素材加边缘光', sourceHash: HASH_B }]),
        sourceHash: HASH_A,
        ledgerModel: 'deepseek-chat',
        ledgerPromptVersion: 'analyze.v2',
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    // 逐篇优先用既有笔记自己的指纹：`--source`/`--note` 就是按笔记选的意思。
    assert.equal(plan.targets[0]?.sourceHash, HASH_B);
    assert.equal(plan.targets[0]?.model, 'deepseek-chat');
    assert.equal(plan.targets[0]?.promptVersion, 'analyze.v2');
  });

  it('model / prompt_version 缺失：报 ok:false（绝不猜），并给一条可读的警告', () => {
    const noGeneration = existingOf([{ id: NOTE_1, title: '素材加边缘光' }]);
    const broken = noGeneration.map((entry) => ({
      relativePath: entry.relativePath,
      frontmatter: { ...entry.frontmatter, model: undefined, prompt_version: undefined },
    })) as unknown as { relativePath: string; frontmatter: NoteFrontmatter }[];
    const plan = mapDraftNotes(planInput({ notes: [draftOf('素材加边缘光')], existing: broken }));
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.ok(plan.problems[0]?.includes('model / prompt_version'), plan.problems.join('\n'));
  });

  it('source_hash 三处都拿不到：报 ok:false，不退化成空字符串', () => {
    const plan = mapDraftNotes(planInput({ notes: [draftOf('盘上没有')], sourceHash: undefined }));
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.ok(plan.problems[0]?.includes('source_hash'), plan.problems.join('\n'));
  });

  it('盘上有、草稿里没有的笔记只计数（orphanExisting），不会被写', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        existing: [
          ...existingOf([{ id: NOTE_1, title: '素材加边缘光' }]),
          ...existingOf([{ id: NOTE_2, title: '这次草稿里没有它' }]),
        ],
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.targets.length, 1);
    assert.equal(plan.orphanExisting, 1);
  });

  it('frontmatter 读不懂的笔记不参与配对（没有 id 就写不出笔记）', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        existing: [{ relativePath: 'notes/坏文件.md', frontmatter: null }],
        ledgerModel: 'deepseek-chat',
        ledgerPromptVersion: 'analyze.v1',
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.targets[0]?.existing, false);
    assert.equal(plan.orphanExisting, 0, '读不懂的既不算配对、也不算“草稿里没有它”');
  });
});

describe('checkPlanTargets —— 写盘前的最后一道检查', () => {
  it('sourceHash 为空串时报出来（退出码 3 的依据）', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        existing: existingOf([{ id: NOTE_1, title: '素材加边缘光' }]),
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    // 手工把指纹掏空，模拟“某一条拿不到指纹”的最坏情况。
    const broken = { ...plan, targets: plan.targets.map((t) => ({ ...t, sourceHash: '' })) };
    const problems = checkPlanTargets(broken);
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('source_hash'), problems.join('\n'));
  });

  it('一切齐备时零问题', () => {
    const plan = mapDraftNotes(
      planInput({
        notes: [draftOf('素材加边缘光')],
        ledgerModel: 'deepseek-chat',
        ledgerPromptVersion: 'analyze.v1',
      }),
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(checkPlanTargets(plan), []);
  });
});

describe('listCandidates —— 三个来源取并集，按 input_id 排序', () => {
  it('只有草稿、没有台账行的输入也出现在候选里（真实数据里真有这种状态）', () => {
    const candidates = listCandidates({
      drafts: new Map([[INPUT_B, 8], [INPUT_A, 13]]),
      ledgerInputIds: [INPUT_A],
      ledgerSourceHashes: new Map([[INPUT_A, HASH_A]]),
      ledgerRowCounts: new Map([[INPUT_A, 13]]),
      noteInputIds: new Map([[INPUT_A, 13]]),
      resolutionInputIds: [INPUT_B],
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.inputId),
      [INPUT_A, INPUT_B].sort((left, right) => left.localeCompare(right)),
    );
    const second = candidates.find((candidate) => candidate.inputId === INPUT_B);
    assert.equal(second?.hasDraft, true);
    assert.equal(second?.draftNotes, 8);
    assert.equal(second?.noteCount, 0);
    assert.equal(second?.ledgerRows, 0);
    assert.equal(second?.sourceHash, null);
    assert.equal(second?.hasResolutions, true);
    const first = candidates.find((candidate) => candidate.inputId === INPUT_A);
    assert.equal(first?.ledgerRows, 13);
    assert.equal(first?.noteCount, 13);
    assert.equal(first?.draftNotes, 13);
    assert.equal(first?.hasResolutions, false);
  });

  it('草稿读不出条数时报 null，而不是假装 0 条', () => {
    const candidates = listCandidates({
      drafts: new Map([[INPUT_A, null]]),
      ledgerInputIds: [],
      ledgerSourceHashes: new Map(),
      ledgerRowCounts: new Map(),
      noteInputIds: new Map(),
      resolutionInputIds: [],
    });
    assert.equal(candidates[0]?.hasDraft, true);
    assert.equal(candidates[0]?.draftNotes, null);
  });

  it('三个来源都空时是空清单（不是一行假的）', () => {
    assert.deepEqual(
      listCandidates({
        drafts: new Map(),
        ledgerInputIds: [],
        ledgerSourceHashes: new Map(),
        ledgerRowCounts: new Map(),
        noteInputIds: new Map(),
        resolutionInputIds: [],
      }),
      [],
    );
  });
});

/* ------------------------------------------------------------------ *
 * runReprocess：默认路径
 * ------------------------------------------------------------------ */

function baseReprocess(paths: VaultPaths, over: Record<string, unknown> = {}) {
  return {
    paths,
    log: collector().log,
    now: NOW,
    newId: idFactory(ulid(0x00).slice(0, 24)),
    ...over,
  };
}

describe('runReprocess · 默认路径（重渲染，不调模型）', () => {
  it('内容与盘上逐字节相同：零写入，报「未变化」，退出码 0（真幂等）', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft });
    const target = noteFilePath(paths, draft.title, NOTE_1);
    const before = readText(target);
    const mtimeBefore = statSync(target).mtimeMs;

    const logs = collector();
    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }));

    assert.equal(code, EXIT.OK);
    assert.equal(readText(target), before, '一个字节都不该变');
    assert.equal(statSync(target).mtimeMs, mtimeBefore, '未变化时连文件都不该被碰');
    assert.ok(
      logs.lines.some((line) => line.includes('全部未变化，0 个文件被改写')),
      logs.lines.join('\n'),
    );
  });

  it('连跑两次：第二次照样零写入（幂等不是“第二次碰巧也一样”）', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft });
    const target = noteFilePath(paths, draft.title, NOTE_1);

    await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));
    const mtimeAfterFirst = statSync(target).mtimeMs;
    const second = collector();
    const code = await runReprocess(
      baseReprocess(paths, { inputId: INPUT_A, yes: true, log: second.log }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(statSync(target).mtimeMs, mtimeAfterFirst);
    assert.equal(readdirSync(paths.notesDir).length, 1);
  });

  it('内容真的变了才覆盖：created 保持原值、updated 变成现在', async () => {
    const paths = freshVault();
    const onDisk = draftOf('素材加边缘光', '旧正文。');
    const inDraft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [inDraft] });
    putNote(paths, { id: NOTE_1, draft: onDisk });
    const target = noteFilePath(paths, draftOf('素材加边缘光').title, NOTE_1);

    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));

    assert.equal(code, EXIT.OK);
    const after = readText(target);
    assert.ok(after.includes('新正文。'), after);
    assert.ok(!after.includes('旧正文。'), after);
    assert.ok(after.includes(`created: ${CREATED}`), after);
    assert.ok(after.includes(`updated: ${STAMP}`), after);
  });

  it('草稿里的标题改了：算出来是另一个文件名，旧的那份留在盘上不动（不替用户删文件）', async () => {
    const paths = freshVault();
    const before = draftOf('旧标题');
    const after = draftOf('新标题');
    writeDraft(paths, INPUT_A, { notes: [after] });
    putNote(paths, { id: NOTE_1, draft: before });
    putInputRow(paths, INPUT_A);

    const logs = collector();
    const code = await runReprocess(
      baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }),
    );

    assert.equal(code, EXIT.OK);
    const names = snapshotDir(paths.notesDir);
    // 配对靠标题，标题对不上就是「新的一条」：新 id + 新文件名；
    // 原来那份仍然是「草稿里找不到它」，留在盘上不动。
    assert.equal(names.length, 2, names.join('\n'));
    assert.ok(names.includes(`旧标题-${NOTE_1.slice(0, 8).toLowerCase()}.md`), names.join('\n'));
    assert.ok(names.includes('新标题-01j8zk4m.md'), names.join('\n'));
    assert.ok(
      logs.lines.some((line) => line.includes('找不到对应标题')),
      logs.lines.join('\n'),
    );
  });

  it('--dry-run：一个字节都不写（notes/ 与 resolutions/ 都不动），退出码 0', async () => {
    const paths = freshVault();
    const inDraft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [inDraft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    const notesBefore = snapshotDir(paths.notesDir);
    const ledgerBefore = snapshotDir(paths.metaDir);

    const logs = collector();
    const code = await runReprocess(
      baseReprocess(paths, { inputId: INPUT_A, dryRun: true, yes: true, log: logs.log }),
    );

    assert.equal(code, EXIT.OK);
    assert.deepEqual(snapshotDir(paths.notesDir), notesBefore);
    assert.deepEqual(snapshotDir(paths.metaDir), ledgerBefore);
    assert.deepEqual(snapshotDir(paths.resolutionsDir), []);
    assert.ok(
      logs.lines.some((line) => line.includes('实际上一个文件都没有写')),
      logs.lines.join('\n'),
    );
  });

  it('没有草稿：抛出用法错误（退出码 2），一个文件都不写', async () => {
    const paths = freshVault();
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光') });
    const before = snapshotDir(paths.notesDir);

    await assert.rejects(
      () => runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true })),
      (error: unknown) => {
        assert.ok(error instanceof LearnMateError);
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.ok(error.message.includes('没有留下草稿'), error.message);
        assert.ok(error.message.includes('--reanalyze'), error.message);
        return true;
      },
    );
    assert.deepEqual(snapshotDir(paths.notesDir), before);
  });

  it('草稿里两条同标题：退出码 3，整批零写入', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('一样的标题'), draftOf('一样的标题')] });
    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));
    assert.equal(code, EXIT.VALIDATION);
    assert.deepEqual(snapshotDir(paths.notesDir), []);
  });

  it('草稿非空但三处都拿不到生成记录：退出码 3（绝不猜），零写入', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('盘上没有的标题')] });
    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));
    assert.equal(code, EXIT.VALIDATION);
    assert.deepEqual(snapshotDir(paths.notesDir), []);
  });

  it('--yes 从零新建一批：条数对得上、status=inbox、input_id 是这次输入', async () => {
    const paths = freshVault();
    const drafts = Array.from({ length: 8 }, (_, index) => draftOf(`第 ${String(index + 1)} 条`));
    writeDraft(paths, INPUT_A, { notes: drafts });
    putInputRow(paths, INPUT_A);

    const logs = collector();
    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }));

    assert.equal(code, EXIT.OK);
    assert.equal(readdirSync(paths.notesDir).length, 8);
    const one = readText(noteFilePath(paths, '第 1 条', idFactory(ulid(0x00).slice(0, 24)).call(null)));
    assert.ok(one.includes('status: inbox'), one);
    assert.ok(one.includes(`input_id: ${INPUT_A}`), one);
  });

  it('--yes 新建出来的一批（status=inbox）再跑一次照样零写入——status 沿用而不是重算', async () => {
    // 回归测试：`--yes` 新建时写进 frontmatter 的是 `inbox`（与 add --yes 一致）。
    // 曾经这里把既有笔记的 status 重算成 `processed`，于是第二次重跑把每一篇都改了一遍，
    // 报「3 条会改写」——幂等就断在 status 上。既有笔记的 status 必须是它自己的。
    const paths = freshVault();
    const drafts = Array.from({ length: 3 }, (_, index) => draftOf(`第 ${String(index + 1)} 条`));
    writeDraft(paths, INPUT_A, { notes: drafts });
    putInputRow(paths, INPUT_A);

    const first = await runReprocess(
      baseReprocess(paths, { inputId: INPUT_A, yes: true, log: collector().log }),
    );
    assert.equal(first, EXIT.OK);
    assert.equal(readdirSync(paths.notesDir).length, 3);

    const before = new Map(
      readdirSync(paths.notesDir).map((name) => [name, readText(join(paths.notesDir, name))]),
    );

    const logs = collector();
    const second = await runReprocess(
      baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }),
    );

    assert.equal(second, EXIT.OK);
    const after = new Map(
      readdirSync(paths.notesDir).map((name) => [name, readText(join(paths.notesDir, name))]),
    );
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [name, content] of before) {
      assert.equal(after.get(name), content, `${name} 第二次重跑不该被改写`);
      assert.ok(content.includes('status: inbox'), `${name} 的 status 应该还是 inbox`);
    }
    assert.ok(
      logs.lines.join('\n').includes('全部未变化'),
      `第二次应该报「全部未变化」，实际：\n${logs.lines.join('\n')}`,
    );
  });

  it('默认路径一行台账都不写：台账文件字节数一个都不变', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    putLedgerRows(paths, INPUT_A, [
      { id: NOTE_1, index: 1, total: 1, path: 'notes/x.md', title: '素材加边缘光' },
    ]);
    const before = readText(paths.ledgerFile);

    const logs = collector();
    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }));

    assert.equal(code, EXIT.OK);
    assert.equal(readText(paths.ledgerFile), before, '台账是 append-only，默认路径不该碰它');
    assert.ok(
      logs.lines.some((line) => line.includes('台账没有改动')),
      logs.lines.join('\n'),
    );
    assert.ok(
      logs.lines.some((line) => line.includes('rebuild-index')),
      '要提示用户去看刷新后的索引',
    );
  });

  it('台账优先：笔记 frontmatter 里的 model 与台账不一致时用台账的', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。'), model: '别的模型' });
    putLedgerRows(paths, INPUT_A, [
      {
        id: NOTE_1,
        index: 1,
        total: 1,
        path: `notes/素材加边缘光-${NOTE_1.slice(0, 8).toLowerCase()}.md`,
        title: '素材加边缘光',
        model: 'deepseek-chat',
        promptVersion: 'analyze.v2',
      },
    ]);

    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));

    assert.equal(code, EXIT.OK);
    const after = readText(noteFilePath(paths, '素材加边缘光', NOTE_1));
    assert.ok(after.includes('model: deepseek-chat'), after);
    assert.ok(after.includes('prompt_version: analyze.v2'), after);
  });

  it('台账里没有这次输入：元数据改从既有笔记里找，照样能重渲染', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });

    const logs = collector();
    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }));

    assert.equal(code, EXIT.OK);
    assert.ok(
      logs.lines.some((line) => line.includes('台账里没有')),
      logs.lines.join('\n'),
    );
    const after = readText(noteFilePath(paths, '素材加边缘光', NOTE_1));
    assert.ok(after.includes('新正文。'), after);
  });

  it('新建笔记不会覆盖同名文件：算出来的文件名已被占用就整批拒绝（退出码 3）', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putInputRow(paths, INPUT_A);

    // 盘上有一篇**别的标题**的笔记，它的文件名恰好等于这次要算出来的那个
    // （文件名 = slug(标题) + id 前 8 位；用户手工改过文件名、或者 slug 规则变了就会这样）。
    const clashId = ulid(0x32);
    const squatterId = '01J8ZK4M2Q7V9N3P5R7T9W2XZZ';
    const occupied = noteFilePath(paths, '素材加边缘光', squatterId);
    const squatter = renderNote(draftOf('别的笔记'), {
      id: squatterId,
      inputId: INPUT_B,
      created: CREATED,
      updated: CREATED,
      status: 'processed',
      sourceHash: HASH_B,
      schemaVersion: 1,
      model: 'deepseek-chat',
      promptVersion: 'analyze.v1',
    });
    writeTextAtomic(occupied, squatter);

    const logs = collector();
    // 撞名守卫抛的是 UnsafeWriteError（退出码 3），与 add 一致：它是「发现了危险」，
    // 不是「跑完了」，所以往上抛给命令层，由 main 归一成退出码 3。
    await assert.rejects(
      () =>
        runReprocess(
          baseReprocess(paths, { inputId: INPUT_A, yes: true, newId: () => clashId, log: logs.log }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof LearnMateError);
        assert.equal(error.exitCode, EXIT.VALIDATION);
        assert.ok(error.message.includes('碰头'), error.message);
        return true;
      },
    );
    assert.equal(readText(occupied), squatter, '整批拒绝之后那个文件要保持原样');
  });

  it('用户 q 取消：一篇都不写、退出码 0', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    const before = readText(noteFilePath(paths, '素材加边缘光', NOTE_1));

    const logs = collector();
    const code = await runReprocess(
      baseReprocess(paths, {
        inputId: INPUT_A,
        prompter: scriptedPrompter({ decisions: ['quit'] }),
        log: logs.log,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(readText(noteFilePath(paths, '素材加边缘光', NOTE_1)), before);
    assert.ok(logs.lines.some((line) => line.includes('已取消')), logs.lines.join('\n'));
  });

  it('逐条跳过：被跳过的那篇一个字节都不动，其余照写', async () => {
    const paths = freshVault();
    const one = draftOf('第一条', '新的一。');
    const two = draftOf('第二条', '新的二。');
    writeDraft(paths, INPUT_A, { notes: [one, two] });
    putNote(paths, { id: NOTE_1, draft: draftOf('第一条', '旧的一。') });
    putNote(paths, { id: NOTE_2, draft: draftOf('第二条', '旧的二。') });
    const untouched = readText(noteFilePath(paths, '第二条', NOTE_2));

    const logs = collector();
    const code = await runReprocess(
      baseReprocess(paths, {
        inputId: INPUT_A,
        prompter: scriptedPrompter({ decisions: ['write', 'skip'] }),
        log: logs.log,
      }),
    );

    assert.equal(code, EXIT.OK);
    assert.ok(readText(noteFilePath(paths, '第一条', NOTE_1)).includes('新的一。'));
    assert.equal(readText(noteFilePath(paths, '第二条', NOTE_2)), untouched);
    assert.ok(logs.lines.some((line) => line.includes('已跳过')), logs.lines.join('\n'));
  });
});

/* ------------------------------------------------------------------ *
 * runReprocess：--note（只重渲染一篇）
 * ------------------------------------------------------------------ */

describe('runReprocess · --note 只重渲染选中的那一篇', () => {
  it('只改选中的那篇：另一篇哪怕内容已经不一样也不动', async () => {
    const paths = freshVault();
    const one = draftOf('第一条', '新的一。');
    const two = draftOf('第二条', '新的二。');
    writeDraft(paths, INPUT_A, { notes: [one, two] });
    putNote(paths, { id: NOTE_1, draft: draftOf('第一条', '旧的一。') });
    putNote(paths, { id: NOTE_2, draft: draftOf('第二条', '旧的二。') });
    const otherBefore = readText(noteFilePath(paths, '第一条', NOTE_1));

    const logs = collector();
    const code = await runReprocess(
      baseReprocess(paths, { noteId: NOTE_2, yes: true, log: logs.log }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(readText(noteFilePath(paths, '第一条', NOTE_1)), otherBefore);
    assert.ok(readText(noteFilePath(paths, '第二条', NOTE_2)).includes('新的二。'));
    assert.ok(
      logs.lines.some((line) => line.includes('共 1 条')),
      logs.lines.join('\n'),
    );
  });

  it('只用 --note 也能找到元数据：input_id 从笔记 frontmatter 里取', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });

    const code = await runReprocess(baseReprocess(paths, { noteId: NOTE_1, yes: true }));

    assert.equal(code, EXIT.OK);
    assert.ok(readText(noteFilePath(paths, '素材加边缘光', NOTE_1)).includes('新正文。'));
  });

  it('知识库里没有这篇笔记：退出码 2，零写入', async () => {
    const paths = freshVault();
    await assert.rejects(
      () => runReprocess(baseReprocess(paths, { noteId: NOTE_1, yes: true })),
      (error: unknown) => {
        assert.ok(error instanceof LearnMateError);
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.ok(error.message.includes('没有这篇笔记'), error.message);
        return true;
      },
    );
  });

  it('笔记的 frontmatter 里没有 input_id：退出码 2，说清只能 --reanalyze', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光');
    const markdown = renderNote(draft, {
      id: NOTE_1,
      // 故意不带 inputId：模拟 rebuild-index 合成出来的那种笔记。
      inputId: '',
      created: CREATED,
      updated: CREATED,
      status: 'processed',
      sourceHash: HASH_A,
      schemaVersion: 1,
      model: 'deepseek-chat',
      promptVersion: 'analyze.v1',
    }).replace(/^input_id: *$/mu, '');
    writeNote(paths, draft.title, NOTE_1, markdown);

    await assert.rejects(
      () => runReprocess(baseReprocess(paths, { noteId: NOTE_1, yes: true })),
      (error: unknown) => {
        assert.ok(error instanceof LearnMateError);
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.ok(error.message.includes('input_id'), error.message);
        assert.ok(error.message.includes('--reanalyze'), error.message);
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ *
 * 裁定重放（还 TD12 的落盘，在这里被读回来）
 * ------------------------------------------------------------------ */

const UNCERTAIN = '导出清晰：尺寸选择 4K，等比例放大';
const REASON = '4K 指合成尺寸还是导出尺寸，原文没有说明';

function draftWithUncertain(): NoteDraft {
  return {
    title: '素材加边缘光',
    summary: '摘要。',
    language: 'zh',
    tags: ['AE'],
    blocks: [
      { type: 'text', text: '正文。' },
      { type: 'uncertain', items: [{ text: UNCERTAIN, reason: REASON }] },
    ],
  };
}

describe('runReprocess · 重放 resolutions/ 里的裁定', () => {
  it('edit：笔记里出现「更正为：」那句话（用户当年写的原话）', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftWithUncertain()] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    writeResolutions(paths, INPUT_A, {
      input_id: INPUT_A,
      ts: CREATED,
      notes: [
        {
          note_index: 1,
          items: [
            {
              item_index: 1,
              text: UNCERTAIN,
              action: 'edit',
              resolution: '4K 指导出尺寸。',
            },
          ],
        },
      ],
    });

    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));

    assert.equal(code, EXIT.OK);
    const after = readText(noteFilePath(paths, '素材加边缘光', NOTE_1));
    assert.ok(after.includes('  - 更正为：4K 指导出尺寸。'), after);
    assert.ok(after.includes('  - 存疑原因：'), after);
  });

  it('drop：那一条从「待确认」里消失', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftWithUncertain()] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    writeResolutions(paths, INPUT_A, {
      input_id: INPUT_A,
      ts: CREATED,
      notes: [{ note_index: 1, items: [{ item_index: 1, text: UNCERTAIN, action: 'drop' }] }],
    });

    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));

    assert.equal(code, EXIT.OK);
    const after = readText(noteFilePath(paths, '素材加边缘光', NOTE_1));
    assert.ok(!after.includes(UNCERTAIN), after);
    assert.ok(!after.includes('待确认'), after);
  });

  it('裁定文件读不出合法 JSON：打一行警告，按「没有任何裁定」重渲染，退出码 0', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftWithUncertain()] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    writeFileSync(resolutionFilePath(paths, INPUT_A), '{ 这不是 JSON', 'utf8');

    const logs = collector();
    const code = await runReprocess(
      baseReprocess(paths, { inputId: INPUT_A, yes: true, log: logs.log }),
    );

    assert.equal(code, EXIT.OK);
    assert.ok(
      logs.lines.some((line) => line.includes('裁定')),
      logs.lines.join('\n'),
    );
    const after = readText(noteFilePath(paths, '素材加边缘光', NOTE_1));
    assert.ok(after.includes(UNCERTAIN), '按 keep 处理，那一条还应该在');
  });

  it('--yes 时只有重放、不产生新裁定文件（没被改过就不该多出一个文件）', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftWithUncertain()] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });

    const code = await runReprocess(baseReprocess(paths, { inputId: INPUT_A, yes: true }));

    assert.equal(code, EXIT.OK);
    assert.deepEqual(listResolutionFiles(paths), []);
  });

  it('交互确认时新做的 d 裁定会落盘（重渲染也会把新决定记下来）', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftWithUncertain()] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });

    const code = await runReprocess(
      baseReprocess(paths, {
        inputId: INPUT_A,
        prompter: scriptedPrompter({ decisions: ['write'], rulings: [{ action: 'drop' }] }),
      }),
    );

    assert.equal(code, EXIT.OK);
    const raw = readResolutions(paths, INPUT_A);
    assert.ok(raw.includes('"action": "drop"'), raw);
  });
});

/* ------------------------------------------------------------------ *
 * 命令层
 * ------------------------------------------------------------------ */

describe('runReprocessCommand · 对象语法与候选清单', () => {
  it('一个选择器都不给：打印候选清单 + 退出码 2 + 零写入', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('素材加边缘光')] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光') });
    const before = snapshotDir(paths.notesDir);
    const configDir = configDirFor(paths.root);

    const { code, out } = await command({ baseDir: configDir });

    assert.equal(code, EXIT.USAGE);
    assert.ok(out.includes('可以重处理的输入'), out);
    assert.ok(out.includes(INPUT_A), out);
    assert.ok(out.includes('--input'), out);
    assert.deepEqual(snapshotDir(paths.notesDir), before);
  });

  it('候选清单报的是草稿条数与盘上篇数两个数，不会把「盘上有几篇」说成「草稿几条」', async () => {
    const paths = freshVault();
    // 真实数据里的 `01M3PD5P2YBCCR5MYYVX5MWMFQ`：草稿 8 条、当年按 q 取消、盘上一篇都没有。
    // 把它说成「草稿 0 条」会让用户以为没东西可渲染——而这恰恰是最值得重处理的一种输入。
    writeDraft(paths, INPUT_A, {
      notes: Array.from({ length: 8 }, (_, index) => draftOf(`第 ${String(index + 1)} 条`)),
    });
    const configDir = configDirFor(paths.root);

    const { code, out } = await command({ baseDir: configDir });

    assert.equal(code, EXIT.USAGE);
    assert.ok(out.includes('草稿 8 条'), out);
    assert.ok(out.includes('盘上 0 篇'), out);
  });

  it('草稿坏掉时候选清单说「草稿读不出来」，不假装 0 条、也不让整条命令失败', async () => {
    const paths = freshVault();
    writeTextAtomic(draftFilePath(paths, INPUT_A), '{ 这不是 JSON');
    const configDir = configDirFor(paths.root);

    const { code, out } = await command({ baseDir: configDir });

    assert.equal(code, EXIT.USAGE);
    assert.ok(out.includes('草稿读不出来'), out);
  });

  it('知识库里什么都没有：候选清单说清「还没有可以重处理的输入」，照样退出码 2', async () => {
    const paths = freshVault();
    const configDir = configDirFor(paths.root);
    const { code, out } = await command({ baseDir: configDir });
    assert.equal(code, EXIT.USAGE);
    assert.ok(out.includes('还没有可以重处理的输入'), out);
  });

  it('--input 与 --note 同时给：退出码 2，零写入', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('素材加边缘光')] });
    const configDir = configDirFor(paths.root);
    const { code } = await command({ baseDir: configDir, input: INPUT_A, note: NOTE_1 });
    assert.equal(code, EXIT.USAGE);
    assert.deepEqual(snapshotDir(paths.notesDir), []);
  });

  it('--source 命中唯一一个输入：等价于 --input，跑得通', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光', '新正文。');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft: draftOf('素材加边缘光', '旧正文。') });
    putLedgerRows(paths, INPUT_A, [
      { id: NOTE_1, index: 1, total: 1, path: 'notes/x.md', title: '素材加边缘光' },
    ]);
    const configDir = configDirFor(paths.root);

    const { code } = await command({ baseDir: configDir, source: HASH_A, yes: true });

    assert.equal(code, EXIT.OK);
    assert.ok(readText(noteFilePath(paths, '素材加边缘光', NOTE_1)).includes('新正文。'));
  });

  it('--source 命中多个输入：打印候选 + 退出码 2（一个指纹对多个输入，绝不猜）', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('素材加边缘光')] });
    writeDraft(paths, INPUT_B, { notes: [draftOf('另一个标题')] });
    putLedgerRows(paths, INPUT_A, [
      { id: NOTE_1, index: 1, total: 1, path: 'notes/a.md', title: '素材加边缘光' },
    ]);
    putLedgerRows(paths, INPUT_B, [
      { id: NOTE_2, index: 1, total: 1, path: 'notes/b.md', title: '另一个标题' },
    ]);
    const before = snapshotDir(paths.notesDir);
    const configDir = configDirFor(paths.root);

    const { code, out } = await command({ baseDir: configDir, source: HASH_A, yes: true });

    assert.equal(code, EXIT.USAGE);
    assert.ok(out.includes(INPUT_A), out);
    assert.ok(out.includes(INPUT_B), out);
    assert.ok(out.includes('--input'), out);
    assert.deepEqual(snapshotDir(paths.notesDir), before);
  });

  it('--source 谁都对不上：退出码 2，并指出指纹从哪里看', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('素材加边缘光')] });
    const configDir = configDirFor(paths.root);
    const { code, err } = await command({ baseDir: configDir, source: HASH_B });
    assert.equal(code, EXIT.USAGE);
    assert.ok(err.includes('没有哪个输入用这个指纹'), err);
  });

  it('默认路径不需要 API Key：环境里没有 LEARNMATE_API_KEY 也照样跑通', async () => {
    const paths = freshVault();
    const draft = draftOf('素材加边缘光');
    writeDraft(paths, INPUT_A, { notes: [draft] });
    putNote(paths, { id: NOTE_1, draft });
    const configDir = configDirFor(paths.root);

    const { code } = await command({ baseDir: configDir, input: INPUT_A, yes: true, env: {} });

    assert.equal(code, EXIT.OK);
  });

  it('--reanalyze 缺 API Key：退出码 2，但草稿与 raw/ 一个字节都不动', async () => {
    const paths = freshVault();
    writeDraft(paths, INPUT_A, { notes: [draftOf('素材加边缘光')] });
    writeFileSync(rawFilePath(paths, INPUT_A), '原文。\n', 'utf8');
    const before = snapshotDir(paths.metaDir);
    const configDir = configDirFor(paths.root);

    const { code, out } = await command({
      baseDir: configDir,
      input: INPUT_A,
      reanalyze: true,
    });

    assert.equal(code, EXIT.USAGE);
    assert.ok(out.includes('检查没通过'), out);
    assert.deepEqual(snapshotDir(paths.metaDir), before);
  });
});
