/**
 * `io/ledger.ts` 的测试。
 *
 * 最重的一组是 `rebuild-index`：它是整个 v0.1 里**唯一**会重写台账的代码路径，
 * 而它存在的全部意义是「台账坏了也得能长回来」。所以这里不做小修小补的断言，
 * 直接构造「删掉 ledger.jsonl」和「台账里半行是被断电劈开的」这两种真实事故现场。
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { renderNote } from '../src/core/render.js';
import type {
  LedgerEntry,
  LedgerInputRow,
  LedgerNoteRow,
  NoteDraft,
  NoteMeta,
} from '../src/core/contracts.js';
import {
  appendEntries,
  findSuccessfulBatch,
  readLedger,
  rebuildLedger,
} from '../src/io/ledger.js';
import { ensureVaultLayout, noteFilePath, vaultPaths, writeNote, writeTextAtomic } from '../src/io/vault.js';
import type { VaultPaths } from '../src/io/vault.js';

const root = mkdtempSync(join(tmpdir(), 'learnmate-ledger-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** 每个用例一个独立知识库目录，互不干扰。 */
function freshVault(): VaultPaths {
  counter += 1;
  const paths = vaultPaths(join(root, `vault-${counter}`));
  ensureVaultLayout(paths);
  return paths;
}

const HASH_A = 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e';
const HASH_B = 'sha256:99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa';
const INPUT_A = '01J8ZC4M7QX2V9K3TB6NPRW5HE';
const INPUT_B = '01J8ZD1A5BX8N2M4P6R8T0W3Y7C';

/** ULID 前 10 位是时间戳，所以同一毫秒产生的 id 前缀相同，只有后面不同。 */
function noteId(index: number): string {
  const suffix = String(index).padStart(2, '0');
  return `01J8ZC9W2M${suffix}QX7V3KTB6NPRW5H`.slice(0, 26);
}

function makeDraft(title: string, overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    title,
    summary: `${title} 的一句话摘要。`,
    language: 'zh',
    tags: ['AE'],
    blocks: [{ type: 'text', text: '正文。' }],
    ...overrides,
  };
}

function makeMeta(noteIndex: number, id: string, sourceHash = HASH_A, inputId = INPUT_A): NoteMeta {
  return {
    id,
    inputId,
    created: `2026-09-28T21:31:2${noteIndex}+08:00`,
    updated: `2026-09-28T21:31:2${noteIndex}+08:00`,
    status: 'processed',
    sourceHash,
    sourceRef: '示例输入.docx',
    schemaVersion: 1,
    model: 'deepseek-chat',
    promptVersion: 'analyze.v1',
  };
}

/** 真的走一遍 render + vault 写入，产生磁盘上一个正常的笔记文件。 */
function putNote(paths: VaultPaths, title: string, id: string, sourceHash = HASH_A, inputId = INPUT_A): string {
  const meta = makeMeta(Number(id.slice(11, 13)) || 1, id, sourceHash, inputId);
  const markdown = renderNote(makeDraft(title), meta);
  return writeNote(paths, title, id, markdown);
}

function makeEntry(overrides: Partial<LedgerNoteRow> = {}): LedgerNoteRow {
  return {
    ts: '2026-09-28T21:31:20+08:00',
    input_id: INPUT_A,
    id: noteId(1),
    note_index: 1,
    note_total: 3,
    source_hash: HASH_A,
    note_path: 'notes/x.md',
    title: 'X',
    tags: ['AE'],
    status: 'processed',
    model: 'deepseek-chat',
    prompt_version: 'analyze.v1',
    tokens_in: 1234,
    tokens_out: 567,
    latency_ms: 8900,
    uncertain_total: 2,
    uncertain_kept: 1,
    outcome: 'ok',
    ...overrides,
  };
}

/**
 * 造一条「输入行」（契约 §9.3）。它没有 `id`/`note_path`/`note_index`——
 * 一次校验失败或用户取消的输入根本没有笔记，这正是不该硬填占位值的原因。
 */
function makeInputRow(overrides: Partial<LedgerInputRow> = {}): LedgerInputRow {
  return {
    ts: '2026-09-28T20:00:00+08:00',
    input_id: INPUT_B,
    source_hash: HASH_B,
    model: 'deepseek-chat',
    prompt_version: 'analyze.v1',
    outcome: 'llm_error',
    reason: '模型服务返回了 401。',
    draft_total: 0,
    ...overrides,
  };
}

/** 只取笔记行：断言 `title`/`note_index` 这些「只有 ok 行才有」的字段前必须先收窄。 */
function okRows(entries: readonly LedgerEntry[]): LedgerNoteRow[] {
  return entries.filter((entry): entry is LedgerNoteRow => entry.outcome === 'ok');
}

/** 只取输入行。 */
function inputRows(entries: readonly LedgerEntry[]): LedgerInputRow[] {
  return entries.filter((entry): entry is LedgerInputRow => entry.outcome !== 'ok');
}

/** 把台账文件内容读成「非空行数组」，方便断言行数。 */
function ledgerLines(paths: VaultPaths): string[] {
  return readFileSync(paths.ledgerFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

describe('readLedger / appendEntries', () => {
  it('台账文件不存在时返回空，而不是抛错', () => {
    const paths = freshVault();
    assert.deepEqual(readLedger(paths), { entries: [], skippedLines: 0 });
  });

  it('一次输入 N 条笔记 → 写 N 行，每行都带同一个 input_id', () => {
    const paths = freshVault();
    const entries = [1, 2, 3].map((i) =>
      makeEntry({ id: noteId(i), note_index: i, note_total: 3 }),
    );
    appendEntries(paths, entries);

    assert.equal(ledgerLines(paths).length, 3);
    const read = readLedger(paths);
    assert.equal(read.skippedLines, 0);
    assert.deepEqual(
      read.entries.map((e) => e.input_id),
      [INPUT_A, INPUT_A, INPUT_A],
    );
    assert.deepEqual(
      okRows(read.entries).map((e) => e.note_index),
      [1, 2, 3],
    );
  });

  it('追加两次不会覆盖第一次（这是「禁止重写历史」）', () => {
    const paths = freshVault();
    appendEntries(paths, [makeEntry({ id: noteId(1) })]);
    appendEntries(paths, [makeEntry({ id: noteId(2), input_id: INPUT_B })]);
    assert.equal(ledgerLines(paths).length, 2);
  });

  it('空数组什么都不写（连文件都不创建）', () => {
    const paths = freshVault();
    appendEntries(paths, []);
    assert.equal(readLedger(paths).entries.length, 0);
  });

  it('断电劈出的半行：跳过并计数，不得崩溃', () => {
    const paths = freshVault();
    const good = JSON.stringify(makeEntry({ id: noteId(1) }));
    const half = '{"ts":"2026-09-28T21:31:2';
    writeTextAtomic(paths.ledgerFile, `${good}\n${half}\n${good}\n`);

    const read = readLedger(paths);
    assert.equal(read.entries.length, 2);
    assert.equal(read.skippedLines, 1);
  });

  it('是合法 JSON、但不是台账条目的行，同样算「读不懂」', () => {
    const paths = freshVault();
    writeTextAtomic(paths.ledgerFile, `${JSON.stringify(makeEntry())}\n{"hello":"world"}\n[]\n`);
    const read = readLedger(paths);
    assert.equal(read.entries.length, 1);
    assert.equal(read.skippedLines, 2);
  });

  it('缺字段的条目算「读不懂」——用途依赖的字段不能缺', () => {
    const paths = freshVault();
    const broken = { ...makeEntry(), source_hash: undefined };
    writeTextAtomic(paths.ledgerFile, `${JSON.stringify(broken)}\n`);
    assert.equal(readLedger(paths).skippedLines, 1);
  });

  it('输入行没有 id 也照样认——它本来就没有笔记', () => {
    const paths = freshVault();
    appendEntries(paths, [makeInputRow({ outcome: 'cancelled', draft_total: 3, skipped_total: 1 })]);

    const read = readLedger(paths);
    assert.equal(read.skippedLines, 0);
    assert.deepEqual(inputRows(read.entries)[0], {
      ts: '2026-09-28T20:00:00+08:00',
      input_id: INPUT_B,
      source_hash: HASH_B,
      model: 'deepseek-chat',
      prompt_version: 'analyze.v1',
      outcome: 'cancelled',
      reason: '模型服务返回了 401。',
      draft_total: 3,
      skipped_total: 1,
    });
  });

  it('放宽只看「这个分支真正要用」的字段：reason 与 draft_total 写坏了也读得出来', () => {
    const paths = freshVault();
    // 多校验一个 draft_total 不会更安全，只会让「将来某个版本写下的行」集体变损坏行，
    // 而损坏行会在下一次 rebuild-index 里被静默抹掉（io/ledger.ts 的注释写了这条教训）。
    writeTextAtomic(
      paths.ledgerFile,
      `${JSON.stringify({ ...makeInputRow(), reason: undefined, draft_total: '三' })}\n`,
    );

    const read = readLedger(paths);
    assert.equal(read.entries.length, 1);
    assert.equal(read.skippedLines, 0);
  });

  it('放宽是有边界的：ok 行缺 id、outcome 不认识、input_id 不是字符串都算读不懂', () => {
    const paths = freshVault();
    writeTextAtomic(
      paths.ledgerFile,
      [
        JSON.stringify({ ...makeEntry(), id: undefined }),
        JSON.stringify({ ...makeInputRow(), outcome: 'i_give_up' }),
        JSON.stringify({ ...makeInputRow(), input_id: 42 }),
        // `duplicate` 保留定义（契约 §9 已发布），读取端必须认它，哪怕没人会写它。
        JSON.stringify({ ...makeInputRow(), outcome: 'duplicate' }),
        JSON.stringify(makeEntry()),
      ].join('\n') + '\n',
    );

    const read = readLedger(paths);
    assert.equal(read.skippedLines, 3);
    assert.deepEqual(
      read.entries.map((e) => e.outcome),
      ['duplicate', 'ok'],
    );
  });
});

describe('findSuccessfulBatch：查重只认 outcome = ok', () => {
  it('找到同 source_hash 的成功记录', () => {
    const paths = freshVault();
    appendEntries(paths, [makeEntry({ outcome: 'ok' })]);
    const found = findSuccessfulBatch(paths, HASH_A);
    assert.notEqual(found, null);
    assert.equal(found?.note_total, 3);
  });

  it('只有失败记录时**不算**处理过（用户显然会想再试一次）', () => {
    const paths = freshVault();
    appendEntries(paths, [
      makeInputRow({ source_hash: HASH_A, outcome: 'llm_error' }),
      makeInputRow({ source_hash: HASH_A, outcome: 'validation_failed' }),
    ]);
    assert.equal(findSuccessfulBatch(paths, HASH_A), null);
  });

  it('别的输入的记录不算数', () => {
    const paths = freshVault();
    appendEntries(paths, [makeEntry({ source_hash: HASH_B })]);
    assert.equal(findSuccessfulBatch(paths, HASH_A), null);
  });

  it('台账被劈坏半行时，剩下的部分照样能查重', () => {
    const paths = freshVault();
    writeTextAtomic(paths.ledgerFile, `${JSON.stringify(makeEntry())}\n{"一半\n`);
    assert.notEqual(findSuccessfulBatch(paths, HASH_A), null);
  });
});

describe('rebuildLedger：从 notes/ 把台账长回来', () => {
  it('删掉 ledger.jsonl 之后，能完整重建出每一条笔记的记录', () => {
    const paths = freshVault();
    putNote(paths, '工具基础设置', noteId(1));
    putNote(paths, 'AE 新建工程与导入素材', noteId(2));
    putNote(paths, '甲脚本 制作位移', noteId(3));

    const report = rebuildLedger(paths);

    assert.equal(report.scanned, 3);
    assert.equal(report.created, 3);
    assert.equal(report.reused, 0);
    assert.equal(report.total, 3);
    assert.deepEqual(report.unreadable, []);

    const read = readLedger(paths);
    assert.equal(read.skippedLines, 0);
    assert.deepEqual(
      okRows(read.entries).map((e) => e.title),
      ['工具基础设置', 'AE 新建工程与导入素材', '甲脚本 制作位移'],
    );
  });

  it('同一次输入的笔记共享 source_hash，于是序号和总数能还原出来', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    putNote(paths, '第二条', noteId(2));
    putNote(paths, '第三条', noteId(3));

    rebuildLedger(paths);
    const { entries } = readLedger(paths);

    assert.deepEqual(
      okRows(entries).map((e) => e.note_index),
      [1, 2, 3],
    );
    assert.deepEqual(
      okRows(entries).map((e) => e.note_total),
      [3, 3, 3],
    );
    assert.deepEqual(new Set(entries.map((e) => e.input_id)), new Set([INPUT_A]));
  });

  it('两次重建得到逐字节相同的文件（否则 diff 全是噪音）', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    putNote(paths, '第二条', noteId(2));

    rebuildLedger(paths);
    const first = readFileSync(paths.ledgerFile, 'utf8');
    rebuildLedger(paths);
    const second = readFileSync(paths.ledgerFile, 'utf8');

    assert.equal(first, second);
  });

  it('沿用原有条目：用量、耗时、存疑统计不会被冲成 0', () => {
    const paths = freshVault();
    const id = noteId(1);
    const notePath = putNote(paths, '第一条', id);
    appendEntries(paths, [
      makeEntry({
        id,
        note_path: 'notes/错的路径.md',
        title: '被改过的旧标题',
        tokens_in: 1234,
        tokens_out: 567,
        latency_ms: 8900,
        uncertain_total: 2,
        uncertain_kept: 1,
      }),
    ]);

    const report = rebuildLedger(paths);
    assert.equal(report.reused, 1);
    assert.equal(report.created, 0);

    const entry = okRows(readLedger(paths).entries)[0];
    assert.equal(entry?.tokens_in, 1234);
    assert.equal(entry?.latency_ms, 8900);
    assert.equal(entry?.uncertain_kept, 1);
    // 但「笔记文件才是真相」的那几个字段要刷成当下的值。
    assert.equal(entry?.title, '第一条');
    assert.equal(entry?.note_path.replace(/\\/g, '/'), 'notes/第一条-01j8zc9w.md');
    assert.equal(notePath.endsWith('01j8zc9w.md'), true);
  });

  it('笔记文件被删了，对应的 ok 条目会被剔除（否则同样内容再也录不进来）', () => {
    const paths = freshVault();
    const keep = noteId(1);
    const gone = noteId(2);
    putNote(paths, '还在的', keep);
    const gonePath = putNote(paths, '被删的', gone);
    rebuildLedger(paths);
    assert.equal(readLedger(paths).entries.length, 2);

    rmSync(gonePath);
    const report = rebuildLedger(paths);

    assert.equal(report.dropped, 1);
    assert.equal(report.total, 1);
    assert.equal(okRows(readLedger(paths).entries)[0]?.id, keep);
  });

  it('失败、取消、跳过这些没有笔记文件的历史条目原样保留', () => {
    const paths = freshVault();
    putNote(paths, '唯一一条', noteId(1));
    appendEntries(paths, [
      makeInputRow({
        input_id: INPUT_A,
        source_hash: HASH_A,
        outcome: 'validation_failed',
        reason: '三次尝试都不合契约：blocks 不是数组。',
      }),
      makeInputRow({
        outcome: 'cancelled',
        reason: '用户取消了这一批。',
        draft_total: 3,
        skipped_total: 1,
        ts: '2026-09-28T20:00:01+08:00',
      }),
      makeInputRow({
        outcome: 'empty',
        reason: '模型认为原文里没有可复用的知识点。',
        ts: '2026-09-28T20:00:02+08:00',
      }),
      makeInputRow({
        outcome: 'unsafe_write',
        reason: '目标文件已存在：notes/第一条-01j8zc9w.md。',
        draft_total: 2,
        ts: '2026-09-28T20:00:03+08:00',
      }),
    ]);

    const report = rebuildLedger(paths);

    assert.equal(report.keptHistory, 4);
    assert.equal(report.total, 5);
    const outcomes = readLedger(paths).entries.map((e) => e.outcome).sort();
    assert.deepEqual(outcomes, ['cancelled', 'empty', 'ok', 'unsafe_write', 'validation_failed']);
  });

  it('重建把历史行逐字节留着（连 reason 里的标点和键顺序都不动）', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    appendEntries(paths, [
      makeInputRow({ outcome: 'validation_failed', reason: '三次尝试都不合契约：blocks 不是数组。' }),
      makeInputRow({
        input_id: INPUT_A,
        source_hash: HASH_A,
        outcome: 'llm_error',
        reason: '模型服务返回了 429（https://example.test/v1/chat/completions）。',
        ts: '2026-09-28T20:00:01+08:00',
      }),
      makeInputRow({
        outcome: 'empty',
        reason: '模型认为原文里没有可复用的知识点。',
        ts: '2026-09-28T20:00:02+08:00',
      }),
      makeInputRow({
        outcome: 'cancelled',
        reason: '用户取消了这一批。',
        draft_total: 3,
        skipped_total: 1,
        ts: '2026-09-28T20:00:03+08:00',
      }),
      makeInputRow({
        outcome: 'skipped',
        reason: '用户跳过了 2 条（草稿都在 draft/ 里）。',
        draft_total: 3,
        skipped_total: 2,
        ts: '2026-09-28T20:00:04+08:00',
      }),
    ]);
    const before = ledgerLines(paths);
    assert.equal(before.length, 5);

    rebuildLedger(paths);

    const after = ledgerLines(paths);
    // JSON.stringify 的输出依赖对象里的键顺序，所以「逐字节相同」比 deepEqual
    // 更严格：它连「历史行被谁顺手规范化过」都能发现。历史行排在这一批笔记之前。
    assert.deepEqual(after.slice(0, 5), before);
    assert.equal(after.length, 6);
  });

  it('输入行排在这一批笔记之前，并列时按 input_id 排（契约 §9.1 的顺序）', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1), HASH_A, INPUT_A);
    appendEntries(paths, [
      makeInputRow({ input_id: INPUT_A, source_hash: HASH_A, outcome: 'empty', ts: '2026-09-28T20:00:00+08:00' }),
      makeInputRow({ input_id: INPUT_B, source_hash: HASH_B, outcome: 'empty', ts: '2026-09-28T20:00:00+08:00' }),
    ]);

    rebuildLedger(paths);
    const entries = readLedger(paths).entries;

    // 时间戳相同 → 按 input_id 排；输入行没有 note_index（当 0），所以排在那批笔记之前。
    assert.deepEqual(
      entries.map((e) => e.input_id),
      [INPUT_A, INPUT_B, INPUT_A],
    );
    assert.deepEqual(
      entries.map((e) => e.outcome),
      ['empty', 'empty', 'ok'],
    );
  });

  it('读不懂的笔记文件被跳过并报出来，其余照常重建（不崩溃、也不静默）', () => {
    const paths = freshVault();
    putNote(paths, '好的一条', noteId(1));
    writeTextAtomic(join(paths.notesDir, '坏掉的一条-01j8zc9v.md'), '# 没有 frontmatter\n');

    const report = rebuildLedger(paths);

    assert.equal(report.scanned, 2);
    assert.equal(report.created, 1);
    assert.equal(report.unreadable.length, 1);
    assert.equal(report.unreadable[0]?.fileName.includes('坏掉的一条'), true);
    assert.match(report.unreadable[0]?.reason ?? '', /frontmatter/);
    // 文件还在磁盘上，一个字都没动。
    assert.equal(readLedger(paths).entries.length, 1);
  });

  it('notes/ 里一个文件都没有时重建出空台账，不抛错', () => {
    const paths = freshVault();
    const report = rebuildLedger(paths);
    assert.equal(report.scanned, 0);
    assert.equal(report.total, 0);
    assert.equal(readFileSync(paths.ledgerFile, 'utf8'), '');
  });

  it('write: false 只报告，不碰磁盘', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    appendEntries(paths, [makeInputRow({ source_hash: HASH_A })]);
    const before = readFileSync(paths.ledgerFile, 'utf8');

    const report = rebuildLedger(paths, { write: false });

    assert.equal(report.writtenTo, null);
    assert.equal(report.total, 2);
    assert.equal(readFileSync(paths.ledgerFile, 'utf8'), before);
  });

  it('原台账里读不懂的行会被报出来（重建会顺手把它们抹掉，不能不说）', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    writeTextAtomic(
      paths.ledgerFile,
      `${JSON.stringify(makeEntry({ id: noteId(1) }))}\n{"ts":"2026-09-28T21:3\n`,
    );

    const report = rebuildLedger(paths, { write: false });

    assert.equal(report.damagedLines, 1);
    assert.equal(report.reused, 1);
  });

  it('台账本来就不存在时，damagedLines 是 0 而不是报错', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    const report = rebuildLedger(paths, { write: false });
    assert.equal(report.damagedLines, 0);
  });

  it('note_path 是相对知识库根、用正斜杠的路径（搬目录不会失效）', () => {
    const paths = freshVault();
    putNote(paths, '第一条', noteId(1));
    rebuildLedger(paths);

    const entry = okRows(readLedger(paths).entries)[0];
    assert.equal(entry?.note_path.startsWith('notes/'), true);
    assert.equal(entry?.note_path.includes('\\'), false);
    assert.equal(entry?.note_path.includes(root), false);
  });

  it('old 文件里没有 input_id 时，合成一个一眼能看出是合成的 id', () => {
    const paths = freshVault();
    const id = noteId(1);
    const meta = makeMeta(1, id);
    // 手工去掉 input_id，模拟 T7 之前写下的笔记文件。
    const markdown = renderNote(makeDraft('第一条'), meta).replace(/\ninput_id: [^\n]*/, '');
    writeNote(paths, '第一条', id, markdown);

    const report = rebuildLedger(paths);
    assert.equal(report.created, 1);
    assert.equal(readLedger(paths).entries[0]?.input_id, `rebuild:${HASH_A.slice(7, 15)}`);
  });

  it('noteFilePath 拼出来的路径与重建记录的 note_path 对得上', () => {
    const paths = freshVault();
    const id = noteId(1);
    const filePath = putNote(paths, '第一条', id);
    assert.equal(filePath, noteFilePath(paths, '第一条', id));
  });
});
