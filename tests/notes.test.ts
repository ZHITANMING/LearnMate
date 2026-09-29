/**
 * `io/notes.ts` 的测试 —— 「从磁盘上的笔记里读回什么」。
 *
 * 这个模块存在的理由是 D36：标签词表（`{{TAG_VOCABULARY}}`）从**笔记本身**取，
 * 不再问台账。所以这里最重要的用例不是「能读出标签」，而是
 * **「把台账整个删掉，标签照样读得出来」** —— 那才是这次改动的判据。
 *
 * 夹具都是真的：真 `renderNote` + 真文件写入。因为这里要测的恰恰是
 * 「磁盘上那种块列表形状的 tags 能不能解析出来」，用内存对象测不到。
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LedgerNoteRow, NoteDraft, NoteMeta } from '../src/core/contracts.js';
import { renderNote } from '../src/core/render.js';
import { appendEntries } from '../src/io/ledger.js';
import { collectKnownTags } from '../src/io/notes.js';
import { ensureVaultLayout, fileExists, vaultPaths, writeNote } from '../src/io/vault.js';
import type { VaultPaths } from '../src/io/vault.js';

const root = mkdtempSync(join(tmpdir(), 'learnmate-notes-'));
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
const INPUT_A = '01J8ZC4M7QX2V9K3TB6NPRW5HE';

/** ULID 前 10 位是同一毫秒共享的时间戳，同一批的 id 只有后面不同。 */
function noteId(index: number): string {
  return `01J8ZC9W2M${String(index).padStart(2, '0')}QX7V3KTB6NPRW5H`.slice(0, 26);
}

function makeDraft(title: string, tags: string[]): NoteDraft {
  return {
    title,
    summary: `${title} 的一句话摘要。`,
    language: 'zh',
    tags,
    blocks: [{ type: 'text', text: '正文。' }],
  };
}

function makeMeta(index: number, id: string): NoteMeta {
  return {
    id,
    inputId: INPUT_A,
    created: `2026-09-29T13:06:2${index}+08:00`,
    updated: `2026-09-29T13:06:2${index}+08:00`,
    status: 'processed',
    sourceHash: HASH_A,
    sourceRef: '示例输入.txt',
    schemaVersion: 1,
    model: 'deepseek-chat',
    promptVersion: 'analyze.v1',
  };
}

/** 真的走一遍 render + vault 写入，产生磁盘上一个正常的笔记文件。 */
function putNote(paths: VaultPaths, index: number, title: string, tags: string[]): string {
  const id = noteId(index);
  const markdown = renderNote(makeDraft(title, tags), makeMeta(index, id));
  return writeNote(paths, title, id, markdown);
}

function okRow(id: string, tags: string[]): LedgerNoteRow {
  return {
    ts: '2026-09-29T13:06:30+08:00',
    input_id: INPUT_A,
    id,
    note_index: 1,
    note_total: 1,
    source_hash: HASH_A,
    note_path: 'notes/whatever.md',
    title: '随便什么标题',
    tags,
    status: 'processed',
    model: 'deepseek-chat',
    prompt_version: 'analyze.v1',
    tokens_in: 100,
    tokens_out: 200,
    latency_ms: 3000,
    uncertain_total: 0,
    uncertain_kept: 0,
    outcome: 'ok',
  };
}

/* ------------------------------------------------------------------ *
 * collectKnownTags
 * ------------------------------------------------------------------ */

describe('collectKnownTags：从笔记的 frontmatter 里取标签', () => {
  it('跨笔记去重，按笔记文件的顺序首次出现', () => {
    const paths = freshVault();
    putNote(paths, 1, '工程图层顺序', ['AE', '合成', '界面']);
    putNote(paths, 2, '边缘光做法', ['AE', '边缘光']);
    putNote(paths, 3, '插件清单', ['插件', '界面']);

    // 顺序不是写入顺序，而是 `listNoteFiles` 的顺序（按文件名排序）。
    // 这里「插件清单」排在「边缘光做法」前面，就是文件名排序的结果（总 U+603B < 插 U+63D2 < 辉 U+8F89）。
    // 排序本身是 `renderTagVocabulary` 的责任，不在这里（D36）。
    assert.deepEqual(collectKnownTags(paths), ['AE', '合成', '界面', '插件', '边缘光']);
  });

  it('trim 掉前后空白、丢掉空标签', () => {
    const paths = freshVault();
    putNote(paths, 1, '乱七八糟', ['  AE  ', '   ', '']);
    putNote(paths, 2, '只有空白', ['   ']);

    assert.deepEqual(collectKnownTags(paths), ['AE']);
  });

  it('tags 是磁盘上的块列表形状也能读出来', () => {
    const paths = freshVault();
    const filePath = putNote(paths, 1, '工程图层顺序', ['AE', '合成']);

    const markdown = readFileSync(filePath, 'utf8');
    assert.match(markdown, /^tags:\n  - AE\n  - 合成$/m, 'frontmatter 里必须是块列表，不是行内数组');

    assert.deepEqual(collectKnownTags(paths), ['AE', '合成']);
  });

  it('一篇笔记都没有时返回空数组，不抛错', () => {
    const paths = freshVault();
    assert.deepEqual(collectKnownTags(paths), []);
  });

  it('读不懂的笔记跳过，不拖累其它笔记的标签', () => {
    const paths = freshVault();
    putNote(paths, 1, '好笔记', ['AE']);
    // 手工劈坏一个文件：没有 frontmatter、id 行也是坏的。
    writeFileSync(join(paths.notesDir, '坏掉的-01j8zc9w2m99qx7v3ktb6nprw5h.md'), '# 只有标题\n', 'utf8');

    assert.deepEqual(collectKnownTags(paths), ['AE']);
  });
});

/* ------------------------------------------------------------------ *
 * D36 的判据：词表不依赖台账
 * ------------------------------------------------------------------ */

describe('collectKnownTags：来源是笔记，不是台账（D36）', () => {
  it('台账整个删掉，标签照样全部读得出来', () => {
    const paths = freshVault();
    putNote(paths, 1, '工程图层顺序', ['AE', '合成', '界面']);
    putNote(paths, 2, '边缘光做法', ['AE', '边缘光', '插件']);
    appendEntries(paths, [okRow(noteId(1), ['AE', '合成', '界面']), okRow(noteId(2), ['AE', '边缘光', '插件'])]);
    const before = collectKnownTags(paths);

    // 契约 §9 与 docs/05-recovery.md 都允许用户这么干。
    rmSync(paths.ledgerFile);
    assert.ok(!fileExists(paths.ledgerFile), '前置条件：台账真的没了');

    assert.deepEqual(collectKnownTags(paths), before);
    assert.deepEqual(collectKnownTags(paths), ['AE', '合成', '界面', '边缘光', '插件']);
  });

  it('只出现在台账、不在任何笔记里的标签不算数', () => {
    const paths = freshVault();
    putNote(paths, 1, '工程图层顺序', ['AE']);
    // 这个标签只在台账里（比如笔记被手工删过）。真相在笔记里，它不该出现。
    appendEntries(paths, [okRow(noteId(1), ['AE', '台账专属的标签'])]);

    assert.deepEqual(collectKnownTags(paths), ['AE']);
  });
});

/* ------------------------------------------------------------------ *
 * 边界：知识库文件系统只有 vault.ts 一个入口
 * ------------------------------------------------------------------ */

const FS_ALLOWLIST = [
  'src/config.ts',
  'src/main.ts',
  'src/commands/add.ts',
  'src/commands/doctor.ts',
  'src/io/prompt.ts',
  'src/io/vault.ts',
];

/**
 * 从编译产物往回找到仓库根（有 `package.json` 与 `src/` 的那一层）。
 * 测试跑的是 `dist-test/`，而这条边界要查的是**真源码**——否则它会去查
 * `dist-test/src/*.js`（没有 `.ts` 文件），然后空着手通过。
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到仓库根目录（从 ${startDir} 往上找 package.json + src/）`);
}

const REPO_ROOT = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
const SRC_DIR = join(REPO_ROOT, 'src');

/** 列出 src/ 下所有 .ts 文件，返回相对仓库根的路径（正斜杠）。 */
function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(relative(REPO_ROOT, full).replace(/\\/g, '/'));
    }
  }
  return found;
}

describe('边界：src/ 下只有豁免名单能 import node:fs', () => {
  it('真的扫到了源码（否则这条测试会空着手通过）', () => {
    const files = listSourceFiles(SRC_DIR);
    assert.ok(files.includes('src/io/vault.ts'), `应该扫到 src/io/vault.ts，实际扫到：${files.join(', ')}`);
    assert.ok(files.length > 15, `src/ 下的 .ts 文件不该这么少：${files.length}`);
  });

  it('没有名单之外的文件碰 node:fs', () => {
    const offenders = listSourceFiles(SRC_DIR).filter((relativePath) => {
      if (FS_ALLOWLIST.includes(relativePath)) return false;
      const text = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
      return /from 'node:fs'|require\('node:fs'\)/.test(text);
    });

    assert.deepEqual(offenders, [], '知识库文件系统只有 src/io/vault.ts 一个入口');
  });

  it('豁免名单里的文件都真的存在，而且真的在用 node:fs', () => {
    for (const relativePath of FS_ALLOWLIST) {
      const full = join(REPO_ROOT, relativePath);
      assert.ok(existsSync(full), `豁免名单里列了不存在的文件：${relativePath}`);
      assert.match(
        readFileSync(full, 'utf8'),
        /from 'node:fs'|require\('node:fs'\)/,
        `${relativePath} 不再用 node:fs 了，就该从豁免名单里删掉`,
      );
    }
  });

  it('notes.ts 自己不在豁免名单里', () => {
    assert.ok(!FS_ALLOWLIST.includes('src/io/notes.ts'), 'notes.ts 必须只通过 vault.ts 碰文件');
  });
});
