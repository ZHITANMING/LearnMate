/**
 * `commands/doctor.ts` 里那节只读「知识库体检」的测试。
 *
 * 体检的全部判断都落在磁盘上（`raw/` 里有几份、台账里有几行），所以这里直接造临时知识库，
 * 让 `vaultReport` 去数，再断言它报出来的话。三件事最要紧：
 *
 * 1. **空知识库不是错误**——刚装好、一次都没录入过的人跑 `doctor`，看到的必须是
 *    「空知识库（还没有录入过）」，而不是一片 ✗。
 * 2. **孤儿原文和孤儿草稿要数对**。契约 §9.3 的不变量是「`raw/<input_id>.txt` 在，
 *    台账里就必须有它的行」，孤儿就是这条不变量的反例，也是 T11 存在的理由。
 * 3. **对不上时要说清楚先跑哪条命令**（`rebuild-index --dry-run`），而不是丢一个数字。
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { vaultReport } from '../src/commands/doctor.js';
import type { LedgerInputRow, LedgerNoteRow, NoteDraft, NoteMeta } from '../src/core/contracts.js';
import { renderNote } from '../src/core/render.js';
import { appendEntries } from '../src/io/ledger.js';
import {
  ensureVaultLayout,
  vaultPaths,
  vaultRelativePath,
  writeDraft,
  writeNote,
  writeQuarantine,
  writeRaw,
  writeTextAtomic,
} from '../src/io/vault.js';
import type { VaultPaths } from '../src/io/vault.js';

const root = mkdtempSync(join(tmpdir(), 'learnmate-doctor-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** 每个用例一个独立知识库目录，互不干扰。 */
function freshVault(): VaultPaths {
  counter += 1;
  const paths = vaultPaths(join(root, `vault-${String(counter)}`));
  ensureVaultLayout(paths);
  return paths;
}

const HASH_A = 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e';
const HASH_B = 'sha256:99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa';
const INPUT_A = '01J8ZC4M7QX2V9K3TB6NPRW5HE';
const INPUT_B = '01J8ZD1A5BX8N2M4P6R8T0W3Y7';
const NOTE_A = '01J8ZC9W2M01QX7V3KTB6NPRW5';

/** 25 字符 + 一位数字 = 26 字符的合法 ULID 前缀，用来批量造孤儿。 */
const ORPHAN_BASE = '01J8ZE5T9CY4P7Q2S5V8X1Z6B';
function orphanId(index: number): string {
  return `${ORPHAN_BASE}${String(index)}`;
}

function makeDraft(title: string): NoteDraft {
  return {
    title,
    summary: `${title} 的一句话摘要。`,
    language: 'zh',
    tags: ['AE'],
    blocks: [{ type: 'text', text: '正文。' }],
  };
}

function makeMeta(id: string): NoteMeta {
  return {
    id,
    inputId: INPUT_A,
    created: '2026-09-28T21:31:20+08:00',
    updated: '2026-09-28T21:31:20+08:00',
    status: 'processed',
    sourceHash: HASH_A,
    sourceRef: '示例输入.docx',
    schemaVersion: 1,
    model: 'deepseek-chat',
    promptVersion: 'analyze.v1',
  };
}

/** 真的走一遍 render + vault 写入，产生磁盘上一个正常的笔记文件。 */
function putNote(paths: VaultPaths, title: string, id: string): string {
  return writeNote(paths, title, id, renderNote(makeDraft(title), makeMeta(id)));
}

function makeEntry(notePath: string, overrides: Partial<LedgerNoteRow> = {}): LedgerNoteRow {
  return {
    ts: '2026-09-28T21:31:20+08:00',
    input_id: INPUT_A,
    id: NOTE_A,
    note_index: 1,
    note_total: 1,
    source_hash: HASH_A,
    note_path: notePath,
    title: '素材加边缘光',
    tags: ['AE'],
    status: 'processed',
    model: 'deepseek-chat',
    prompt_version: 'analyze.v1',
    tokens_in: 1234,
    tokens_out: 567,
    latency_ms: 8900,
    uncertain_total: 0,
    uncertain_kept: 0,
    outcome: 'ok',
    ...overrides,
  };
}

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

describe('vaultReport（知识库体检）', () => {
  it('知识库目录还不存在时，报「空知识库」而不是一片 ✗', () => {
    const paths = vaultPaths(join(root, 'never-created'));
    const report = vaultReport(paths.root);

    assert.match(report, /知识库体检/);
    assert.ok(report.includes('空知识库（还没有录入过）'));
    assert.ok(!report.includes('✗'));
  });

  it('骨架建好了但一次都没录入过，同样是空知识库', () => {
    const paths = freshVault();
    const report = vaultReport(paths.root);

    assert.ok(report.includes('空知识库（还没有录入过）'));
    assert.ok(!report.includes('✗'));
  });

  it('一切对得上时每一项都是 ✓', () => {
    const paths = freshVault();
    const notePath = putNote(paths, '素材加边缘光', NOTE_A);
    writeRaw(paths, INPUT_A, '素材加边缘光：抠出发光部分。\n');
    writeDraft(paths, INPUT_A, { notes: [] });
    appendEntries(paths, [makeEntry(vaultRelativePath(paths, notePath))]);

    const report = vaultReport(paths.root);

    assert.match(report, /原文\s+1 份/);
    assert.match(report, /草稿\s+1 份/);
    assert.match(report, /笔记\s+1 篇/);
    assert.match(report, /台账\s+1 行（笔记 1 行，历史 0 行）/);
    assert.ok(report.includes('孤儿原文      ✓ 没有'));
    assert.ok(report.includes('孤儿草稿      ✓ 没有'));
    assert.ok(report.includes('notes 与台账  ✓ 对得上（1 篇）'));
    assert.ok(report.includes('台账坏行      ✓ 没有'));
    assert.ok(report.includes('校验现场      ✓ 没有'));
    assert.ok(report.includes('历史行        ✓ 没有（每一次输入都有笔记）'));
    assert.ok(!report.includes('✗'));
  });

  it('原文与草稿在、台账里却没有它的行 —— 这就是孤儿，也是 T11 存在的理由', () => {
    const paths = freshVault();
    writeRaw(paths, INPUT_B, '一次走到原文落盘、却没有任何结局的输入。\n');
    writeDraft(paths, INPUT_B, { notes: [] });

    const report = vaultReport(paths.root);

    assert.ok(report.includes('孤儿原文      ✗ 1 个'));
    assert.ok(report.includes('孤儿草稿      ✗ 1 个'));
    assert.ok(report.includes('raw/01J8ZD1A5BX8N2M4P6R8T0W3Y7.txt'));
    // 只报告不清理，所以必须说清楚「别自己动手」。
    assert.ok(report.includes('别手工删：raw/ 里的原文是唯一的一份'));
  });

  it('台账里有读不懂的行要数出来（下一次 rebuild-index 会把它抹掉）', () => {
    const paths = freshVault();
    const notePath = putNote(paths, '素材加边缘光', NOTE_A);
    writeTextAtomic(
      paths.ledgerFile,
      `${JSON.stringify(makeEntry(vaultRelativePath(paths, notePath)))}\n` +
        '{"ts":"2026-09-28T20:00:00+08:00","input_id":"坏行\n',
    );

    const report = vaultReport(paths.root);

    assert.ok(report.includes('台账坏行      ✗ 1 行读不出来'));
    assert.match(report, /台账\s+1 行（笔记 1 行，历史 0 行）/);
  });

  it('notes 与台账对不上时，提示先跑 rebuild-index --dry-run', () => {
    const paths = freshVault();
    const notePath = putNote(paths, '素材加边缘光', NOTE_A);
    // 磁盘上多一篇没进台账的笔记（比如上次写笔记之后才崩掉）。
    putNote(paths, 'AE 位移效果', '01J8ZC9W2M02QX7V3KTB6NPRW5');
    appendEntries(paths, [makeEntry(vaultRelativePath(paths, notePath))]);

    const report = vaultReport(paths.root);

    assert.ok(report.includes('notes 与台账  ✗ 对不上：notes/ 里 2 篇，台账里 1 条'));
    assert.ok(report.includes('node dist/main.js rebuild-index --dry-run'));
  });

  it('校验现场报个数、最近一个的文件名，以及它说的问题', () => {
    const paths = freshVault();
    writeRaw(paths, INPUT_B, '素材。\n');
    writeQuarantine(paths, INPUT_B, {
      input_id: INPUT_B,
      message: '模型连续 3 次都没给出合法 JSON。',
      attempts: 3,
      raw_outputs: ['第一次的原始产出', '第二次的原始产出', '第三次的原始产出'],
    });

    const report = vaultReport(paths.root);

    assert.ok(report.includes('校验现场      ✗ 1 个，最近的一个：'));
    assert.ok(report.includes('quarantine/01J8ZD1A5BX8N2M4P6R8T0W3Y7.json'));
    assert.ok(report.includes('它说：模型连续 3 次都没给出合法 JSON。'));
  });

  it('历史行按 outcome 分组小计（T12 要按它筛选，所以现在就得数清楚）', () => {
    const paths = freshVault();
    appendEntries(paths, [
      makeInputRow({ outcome: 'cancelled', input_id: '01J8ZD1A5BX8N2M4P6R8T0W3Y7C', draft_total: 3 }),
      makeInputRow({ outcome: 'empty', input_id: '01J8ZE5T9CY4P7Q2S5V8X1Z6B1', draft_total: 0 }),
      makeInputRow({ outcome: 'llm_error', input_id: '01J8ZE5T9CY4P7Q2S5V8X1Z6B2', draft_total: 0 }),
    ]);

    const report = vaultReport(paths.root);

    assert.ok(report.includes('历史行        3 行：cancelled 1，empty 1，llm_error 1'));
  });

  it('同类超过 5 个只列前 5 个 —— 医生负责诊断，不负责刷屏', () => {
    const paths = freshVault();
    for (let index = 1; index <= 7; index += 1) {
      writeRaw(paths, orphanId(index), `第 ${String(index)} 份没人认领的原文。\n`);
    }

    const report = vaultReport(paths.root);
    const shown = report.split('\n').filter((line) => line.startsWith('      .learnmate/raw/'));

    assert.ok(report.includes('孤儿原文      ✗ 7 个'));
    assert.equal(shown.length, 5);
    assert.ok(report.includes('…… 还有 2 个'));
  });
});
