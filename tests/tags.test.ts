/**
 * `learnmate tags` 的测试。
 *
 * 大部分用例是纯函数（`renderTagList` / `countTags`），另有一条**最要紧的**集成用例：
 * 把这条命令的输出与 `add` 真正注入给模型的那份词表**逐行比对**。那一条是在钉住
 * 「用户看到的和模型看到的是同一份」，而不是钉住某个字符串长什么样。
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NoteSummary } from '../src/core/contracts.js';
import { EXIT } from '../src/core/errors.js';
import type { ExitCode } from '../src/core/errors.js';
import { EMPTY_VOCABULARY, renderTagVocabulary } from '../src/core/prompt.js';
import { renderNote } from '../src/core/render.js';
import { EMPTY_TAGS_MESSAGE, countTags, renderTagList, runTagsCommand } from '../src/commands/tags.js';
import { collectKnownTags } from '../src/io/notes.js';
import { ensureVaultLayout, vaultPaths, writeNote } from '../src/io/vault.js';
import type { VaultPaths } from '../src/io/vault.js';

const root = mkdtempSync(join(tmpdir(), 'learnmate-tags-'));
after(() => rmSync(root, { recursive: true, force: true }));

const HASH_A = 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e';
const INPUT_A = '01M3NRXP9V35CYARGJW9FR9F31';

function summaryWithTags(tags: string[]): NoteSummary {
  return {
    path: 'C:/vault/notes/x.md',
    relativePath: 'notes/x.md',
    frontmatter: {
      id: '01M3NRXYPSEJ8PY09XTSZ5S4YA',
      input_id: INPUT_A,
      title: 'x',
      created: '2026-09-29T13:06:20+08:00',
      updated: '2026-09-29T13:06:20+08:00',
      summary: 'x',
      tags,
      status: 'processed',
      source_hash: HASH_A,
      schema_version: 1,
      language: 'zh',
      model: 'deepseek-chat',
      prompt_version: 'analyze.v1',
    },
  };
}

/* ------------------------------------------------------------------ *
 * 输出格式
 * ------------------------------------------------------------------ */

describe('renderTagList', () => {
  it('一行一个标签，没有前缀、没有 #、没有计数', () => {
    assert.equal(renderTagList(['AE', '合成']), 'AE\n合成\n');
  });

  it('空列表打那一行说明', () => {
    assert.equal(renderTagList([]), EMPTY_TAGS_MESSAGE);
    assert.equal(EMPTY_TAGS_MESSAGE, '（还没有任何标签。）\n');
  });

  it('--counts 在标签后面追加制表符与次数', () => {
    const counts = new Map([['AE', 3]]);
    assert.equal(renderTagList(['AE'], counts), 'AE\t3\n');
  });

  it('--counts 不改变行的顺序', () => {
    const tags = ['AE', '合成', '插件'];
    const counts = new Map([
      ['AE', 1],
      ['合成', 9],
      ['插件', 5],
    ]);
    assert.deepEqual(
      renderTagList(tags, counts)
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('\t')[0]),
      tags,
    );
  });

  it('词表里没有的标签记 0，不抛错也不漏行', () => {
    assert.equal(renderTagList(['AE'], new Map()), 'AE\t0\n');
  });
});

/* ------------------------------------------------------------------ *
 * 计数
 * ------------------------------------------------------------------ */

describe('countTags', () => {
  it('数的是「几篇笔记用过」，不是「出现过几次」', () => {
    const counts = countTags([
      summaryWithTags(['AE', 'AE', '合成']),
      summaryWithTags(['AE']),
    ]);
    assert.equal(counts.get('AE'), 2);
    assert.equal(counts.get('合成'), 1);
  });

  it('标签前后空白按 trim 后的样子归并', () => {
    const counts = countTags([summaryWithTags([' AE ']), summaryWithTags(['AE'])]);
    assert.deepEqual([...counts.keys()], ['AE']);
    assert.equal(counts.get('AE'), 2);
  });

  it('空标签不计入', () => {
    assert.equal(countTags([summaryWithTags(['', '   '])]).size, 0);
  });

  it('读不懂的笔记不参与计数，也不让整件事失败', () => {
    const counts = countTags([
      summaryWithTags(['AE']),
      { path: 'p', relativePath: 'notes/坏.md', frontmatter: null, problem: '坏了' },
    ]);
    assert.deepEqual([...counts.keys()], ['AE']);
  });
});

/* ------------------------------------------------------------------ *
 * 完整命令
 * ------------------------------------------------------------------ */

let vaultCounter = 0;
function freshVault(): VaultPaths {
  vaultCounter += 1;
  const paths = vaultPaths(join(root, `vault-${vaultCounter}`));
  ensureVaultLayout(paths);
  return paths;
}

let noteCounter = 0;
function makeNote(paths: VaultPaths, title: string, tags: string[]): void {
  noteCounter += 1;
  const id = `01M3NRXY${'0'.repeat(16)}${noteCounter.toString(36).toUpperCase().padStart(2, '0')}`;
  const created = '2026-09-29T13:06:20+08:00';
  const markdown = renderNote(
    {
      title,
      summary: '摘要。',
      language: 'zh',
      tags,
      blocks: [{ type: 'text', text: '正文。' }],
    },
    {
      id,
      inputId: INPUT_A,
      created,
      updated: created,
      status: 'processed',
      sourceHash: HASH_A,
      sourceRef: '示例输入.txt',
      schemaVersion: 1,
      model: 'deepseek-chat',
      promptVersion: 'analyze.v1',
    },
  );
  writeNote(paths, title, id, markdown);
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

function captureStdout(run: () => ExitCode): { code: ExitCode; out: string } {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  try {
    return { code: run(), out };
  } finally {
    process.stdout.write = original;
  }
}

/** 把词表文本还原成标签数组：去掉 `- ` 前缀与「还有 N 个没列出来」那行。 */
function vocabularyLines(vocabulary: string): string[] {
  return vocabulary
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

describe('runTagsCommand', () => {
  it('空知识库：打那一行说明，退出码 0', () => {
    const paths = freshVault();
    const { code, out } = captureStdout(() => runTagsCommand({ baseDir: configDirFor(paths.root) }));

    assert.equal(code, EXIT.OK);
    assert.equal(out, EMPTY_TAGS_MESSAGE);
  });

  it('按 UTF-16 升序，与标签写进笔记的顺序无关', () => {
    const paths = freshVault();
    makeNote(paths, '第一篇', ['合成', 'AE', '插件']);
    makeNote(paths, '第二篇', ['界面', 'AE']);

    const { out } = captureStdout(() => runTagsCommand({ baseDir: configDirFor(paths.root) }));

    // 合成 U+5408 < 插件 U+63D2 < 界面 U+754C —— 按码元，不按笔画也不按拼音。
    assert.deepEqual(out.split('\n').filter((line) => line !== ''), ['AE', '合成', '插件', '界面']);
  });

  it('--counts 的次数正确，且行顺序与不带 --counts 时完全一致', () => {
    const paths = freshVault();
    makeNote(paths, '第一篇', ['合成', 'AE', 'AE']);
    makeNote(paths, '第二篇', ['界面', 'AE']);
    const configDir = configDirFor(paths.root);

    const plain = captureStdout(() => runTagsCommand({ baseDir: configDir })).out;
    const counted = captureStdout(() => runTagsCommand({ baseDir: configDir, counts: true })).out;

    assert.equal(counted, 'AE\t2\n合成\t1\n界面\t1\n');
    assert.deepEqual(
      counted
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('\t')[0]),
      plain.split('\n').filter((line) => line !== ''),
    );
  });

  it('与 add 注入给模型的词表是同一份（同源）', () => {
    const paths = freshVault();
    makeNote(paths, '第一篇', ['合成', 'AE']);
    makeNote(paths, '第二篇', ['界面', 'AE']);
    const configDir = configDirFor(paths.root);

    const commandOutput = captureStdout(() => runTagsCommand({ baseDir: configDir })).out;

    // 这正是 `add` 组装系统消息时用的那一条链：collectKnownTags → renderTagVocabulary。
    const injected = renderTagVocabulary(collectKnownTags(paths));

    assert.deepEqual(
      commandOutput.split('\n').filter((line) => line !== ''),
      vocabularyLines(injected),
    );
    assert.notEqual(injected, EMPTY_VOCABULARY);
  });

  it('空库那两种「没有标签」的措辞是不同的：命令给一行，提示词给一句完整说明', () => {
    const paths = freshVault();
    const commandOutput = captureStdout(() =>
      runTagsCommand({ baseDir: configDirFor(paths.root) }),
    ).out;

    assert.equal(commandOutput, EMPTY_TAGS_MESSAGE);
    assert.equal(renderTagVocabulary(collectKnownTags(paths)), EMPTY_VOCABULARY);
    assert.notEqual(commandOutput.trim(), EMPTY_VOCABULARY.trim());
  });
});
