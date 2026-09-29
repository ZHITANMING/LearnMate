/**
 * 台账：`vault/.learnmate/ledger.jsonl`。
 *
 * 它是整个 v0.1 里**唯一的「记忆」**——知识库里的笔记文件本身不知道自己是哪一次输入
 * 产生的，只有台账记得。它干两件事：
 *
 * 1. **查重**：同一个 `source_hash` 已经处理过就不重复处理（契约第 6.5 节）。
 * 2. **审计**：回答「我那次输入到底怎么了」——失败、取消、跳过也都会留下记录。
 *
 * 三条硬性质：
 * - 台账里有**两种行**，按 `outcome` 判别（契约 §9）：笔记行（`outcome = ok`，一行一条
 *   笔记，一次输入产出 N 条就写 N 行）与输入行（非 `ok`，**一行 = 一次输入**）。
 * - **只追加，禁止重写历史**（`rebuild-index` 是唯一例外，见下）。
 * - 它是**派生数据**：笔记行可以从 `notes/` 重建；输入行重建不回来——除了台账没别处记得。
 *
 * 还有一条不变量（契约 §9.3）：**`raw/<input_id>.txt` 在，台账里就必须有带这个
 * `input_id` 的行。** 这条是 T11 立的，判据在 `doctor` 的体检里。
 *
 * 关于最后一条有个容易被忽略的地方：笔记文件里**没有** tokens、耗时、存疑统计
 * （那些信息只在这一刻存在过）。所以「重建」不等于「还原」。
 *
 * 本模块不 import `node:fs`：所有文件读写都经过 `vault.ts`，这样「知识库文件系统
 * 只有一处入口」这条硬约束才真的能靠 grep 验证。
 */

import { parseFrontmatter } from '../core/frontmatter.js';
import type {
  LedgerEntry,
  LedgerInputRow,
  LedgerNoteRow,
  LedgerOutcome,
  NoteFrontmatter,
} from '../core/contracts.js';
import {
  appendText,
  fileExists,
  listNoteFiles,
  readText,
  vaultRelativePath,
  writeTextAtomic,
} from './vault.js';
import type { VaultPaths } from './vault.js';

/** 台账读取结果。`skippedLines` 不是错误，是**必须报告出来的事实**。 */
export interface LedgerReadResult {
  entries: LedgerEntry[];
  /** 无法解析的行数（断电留下的半行、被手工改坏的行）。 */
  skippedLines: number;
}

const OUTCOMES: readonly string[] = [
  'ok',
  'skipped',
  'duplicate',
  'cancelled',
  'validation_failed',
  'llm_error',
  'empty',
  'unsafe_write',
] satisfies readonly LedgerOutcome[];

/**
 * 判断一行 JSON 是不是台账条目。
 *
 * 故意**宽松**：只按 `outcome` 分支，校验该分支用途真正依赖的那几个字段。
 * 多校验一个 `reason` 或 `latency_ms` 不会更安全，只会让「旧版本写下的条目」
 * 在升级后集体变成「损坏行」——而损坏行会在下一次 `rebuild-index` 里被静默抹掉。
 */
function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;

  // 两种行都必定有、而且读取端真的会用到的字段。
  if (
    typeof record['input_id'] !== 'string' ||
    typeof record['source_hash'] !== 'string' ||
    typeof record['outcome'] !== 'string' ||
    !OUTCOMES.includes(record['outcome'])
  ) {
    return false;
  }

  // 笔记行还必须有 `id`：查重去重与 rebuild 的「沿用原条目」都按它认人。
  // 输入行到此为止——它没有 id，也不该有。
  return record['outcome'] === 'ok' ? typeof record['id'] === 'string' : true;
}

/** 读台账。文件不存在不是错误——第一次跑 `add` 之前它本来就不存在。 */
export function readLedger(paths: VaultPaths): LedgerReadResult {
  if (!fileExists(paths.ledgerFile)) return { entries: [], skippedLines: 0 };

  const text = readText(paths.ledgerFile);
  const entries: LedgerEntry[] = [];
  let skippedLines = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 断电留下的半行。契约第 9 节：跳过并计数，不得崩溃。
      skippedLines += 1;
      continue;
    }

    if (!isLedgerEntry(parsed)) {
      skippedLines += 1;
      continue;
    }
    entries.push(parsed);
  }

  return { entries, skippedLines };
}

/**
 * 追加一批条目。**一次输入调用一次**，N 条笔记一次写完。
 *
 * 为什么要一次性写：每行一次 `appendFileSync` 在断电时可能只写下一半，
 * 而一次写一整块至少让「要么全有、要么全无」的概率高得多。
 */
export function appendEntries(paths: VaultPaths, entries: readonly LedgerEntry[]): void {
  if (entries.length === 0) return;
  const block = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  appendText(paths.ledgerFile, block);
}

/**
 * 查重：这份输入是不是已经成功处理过（契约第 6.5 节）。
 *
 * **只认 `outcome = ok`。** 失败、取消、跳过都不算「处理过」——用户显然会想再试一次，
 * 拿一条 `llm_error` 去拦他，是把程序的失败变成他的麻烦。
 *
 * 返回第一条匹配的记录用它来打印「已于 <时间> 处理过，产出 N 条笔记」。
 */
export function findSuccessfulBatch(paths: VaultPaths, sourceHash: string): LedgerNoteRow | null {
  const { entries } = readLedger(paths);
  const found = entries.find((entry) => entry.outcome === 'ok' && entry.source_hash === sourceHash);
  return found !== undefined && found.outcome === 'ok' ? found : null;
}

/* ------------------------------------------------------------------ *
 * rebuild-index
 * ------------------------------------------------------------------ */

/** 一次重建的账目。每个数字都要报给用户看——重建最怕的就是「静默地少了几条」。 */
export interface RebuildReport {
  /** `notes/` 下扫到的 `.md` 文件数。 */
  scanned: number;
  /** 读不懂、被跳过的文件。 */
  unreadable: Array<{ fileName: string; reason: string }>;
  /** 非 `ok` 的历史条目，原样保留。 */
  keptHistory: number;
  /** `ok` 条目，笔记文件里也在，沿用原有台账的完整记录。 */
  reused: number;
  /** `ok` 条目，台账里没有（或者在重建中被剔除了），从笔记文件新造。 */
  created: number;
  /** 原有 `ok` 条目，但笔记文件已经不在了 —— 被剔除。 */
  dropped: number;
  /**
   * 原台账里读不懂的行数。
   *
   * 这个数字必须报出来：重建是「把台账重写一遍」，重写会**顺手抹掉**那些读不懂的行。
   * 不报，用户就永远不知道自己的台账里曾经有过一条被断电劈开的记录。
   */
  damagedLines: number;
  /** 重建后台账的总条目数。 */
  total: number;
  /** 写回的文件路径；`write: false` 时为 `null`。 */
  writtenTo: string | null;
}

interface ReadNote {
  filePath: string;
  frontmatter: NoteFrontmatter;
}

/** 从 `sha256:3f2a…` 里取前 8 位十六进制，用于合成一个能一眼看出是合成的 id。 */
function shortHash(sourceHash: string): string {
  const colon = sourceHash.indexOf(':');
  const hex = colon === -1 ? sourceHash : sourceHash.slice(colon + 1);
  return hex.slice(0, 8);
}

/**
 * 重建台账。
 *
 * 规则：
 * - `outcome = ok` 的条目**由 `notes/` 派生**。笔记文件还在、台账里也有 → 沿用台账那一条
 *   （它带着用量和耗时，笔记文件里没有）；台账里没有 → 从 frontmatter 新造一条；
 *   笔记文件没了 → 从台账里剔除（否则删掉一条笔记之后，同样的内容再也录不进来了）。
 * - 非 `ok` 的条目（失败、取消、跳过、没东西可整理、撞名）**没有笔记文件**，是纯历史，
 *   原样保留：写进去时是哪几个字段，读回来就还是哪几个字段（契约 §9.1）。
 * - 顺序固定为 `ts` → `input_id` → `note_index`（输入行按 `0` 排），与扫描顺序无关。
 *
 * 这是 `ledger.jsonl` **唯一**会被重写的场合。`add` 永远只追加。
 */
export function rebuildLedger(
  paths: VaultPaths,
  options: { write?: boolean } = {},
): RebuildReport {
  const shouldWrite = options.write ?? true;
  const existing = readLedger(paths);
  const notePaths = listNoteFiles(paths);

  const readable: ReadNote[] = [];
  const unreadable: Array<{ fileName: string; reason: string }> = [];

  for (const filePath of notePaths) {
    const relativePath = vaultRelativePath(paths, filePath);
    let text: string;
    try {
      text = readText(filePath);
    } catch (error) {
      unreadable.push({
        fileName: relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed.ok) {
      unreadable.push({ fileName: relativePath, reason: parsed.reason });
      continue;
    }
    readable.push({ filePath, frontmatter: parsed.frontmatter });
  }

  // 按 source_hash 分组：同一次输入拆出的笔记共享它，于是索引与总数可以还原出来。
  const groups = new Map<string, ReadNote[]>();
  for (const note of readable) {
    const key = note.frontmatter.source_hash;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [note]);
    else bucket.push(note);
  }

  const okEntries: LedgerNoteRow[] = [];
  for (const [sourceHash, bucket] of groups) {
    // ULID 前 10 位是时间，字典序即产生顺序 —— 这正好把 note_index 还原回原文顺序。
    bucket.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0));

    const fromFrontmatter = bucket.find((note) => note.frontmatter.input_id !== undefined);
    const groupInputId = fromFrontmatter?.frontmatter.input_id ?? `rebuild:${shortHash(sourceHash)}`;

    bucket.forEach((note, index) => {
      okEntries.push(synthesizeEntry(paths, note, groupInputId, index + 1, bucket.length));
    });
  }

  const existingOk = new Map<string, LedgerNoteRow>();
  const history: LedgerInputRow[] = [];
  for (const entry of existing.entries) {
    if (entry.outcome !== 'ok') {
      history.push(entry);
      continue;
    }
    if (!existingOk.has(entry.id)) existingOk.set(entry.id, entry);
  }

  const liveIds = new Set(okEntries.map((entry) => entry.id));
  let dropped = 0;
  for (const id of existingOk.keys()) {
    if (!liveIds.has(id)) dropped += 1;
  }

  let reused = 0;
  const merged = okEntries.map((fresh) => {
    const previous = existingOk.get(fresh.id);
    if (previous === undefined) return fresh;
    reused += 1;
    // 沿用旧条目，但把笔记文件才是真相的那几个字段刷成当下的值——
    // 用户可能改过标题、标签或状态，而那正是 rebuild 想反映的东西。
    return {
      ...previous,
      note_path: fresh.note_path,
      title: fresh.title,
      tags: fresh.tags,
      status: fresh.status,
      source_hash: fresh.source_hash,
    };
  });

  const all = [...history, ...merged].sort(compareEntries);

  const writtenTo = shouldWrite ? writeRebuiltLedger(paths, all) : null;

  return {
    scanned: notePaths.length,
    unreadable,
    keptHistory: history.length,
    reused,
    created: merged.length - reused,
    dropped,
    damagedLines: existing.skippedLines,
    total: all.length,
    writtenTo,
  };
}

function synthesizeEntry(
  paths: VaultPaths,
  note: ReadNote,
  inputId: string,
  noteIndex: number,
  noteTotal: number,
): LedgerNoteRow {
  const { frontmatter } = note;
  return {
    // 笔记的 created 就是这次输入被处理的时间，比「现在」诚实得多。
    ts: frontmatter.created,
    input_id: inputId,
    id: frontmatter.id,
    note_index: noteIndex,
    note_total: noteTotal,
    source_hash: frontmatter.source_hash,
    note_path: vaultRelativePath(paths, note.filePath),
    title: frontmatter.title,
    tags: frontmatter.tags,
    status: frontmatter.status,
    model: frontmatter.model,
    prompt_version: frontmatter.prompt_version,
    // 下面这些笔记文件里根本没有，只能补 0。它们不是「零」，是「不知道」。
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 0,
    uncertain_total: 0,
    uncertain_kept: 0,
    outcome: 'ok',
  };
}

/**
 * 排序：`ts` → `input_id` → `note_index` → `id`（契约 §9.1）。
 *
 * 输入行**没有** `note_index`，按 `0` 参与排序，于是它排在这次输入产出的那些笔记**之前**
 * ——「先看结局，再看产出」。不能直接写 `a.note_index - b.note_index`：缺失的一方会算出
 * `NaN`，而比较函数返回 `NaN` 时 `Array.prototype.sort` 的行为是未定义的（V8 上表现为
 * 顺序完全不稳定），契约 §9.1 的「跑两次逐字节相同」就没了。
 */
function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.input_id !== b.input_id) return a.input_id < b.input_id ? -1 : 1;
  const aIndex = sortIndex(a);
  const bIndex = sortIndex(b);
  if (aIndex !== bIndex) return aIndex - bIndex;
  const aId = a.outcome === 'ok' ? a.id : '';
  const bId = b.outcome === 'ok' ? b.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** 排序用的序号：笔记行是 `note_index`，输入行一律 `0`。 */
function sortIndex(entry: LedgerEntry): number {
  return entry.outcome === 'ok' ? entry.note_index : 0;
}

/** 重写整份台账。**只有 `rebuild-index` 会走到这里**，而且是原子写。 */
function writeRebuiltLedger(paths: VaultPaths, entries: readonly LedgerEntry[]): string {
  const content = entries.length === 0 ? '' : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeTextAtomic(paths.ledgerFile, content);
  return paths.ledgerFile;
}
