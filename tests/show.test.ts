/**
 * `learnmate show` 的测试。
 *
 * 分两层：`selectNotes` / `renderCandidates` 是纯函数，直接断言字符串与集合；
 * `runShowCommand` 走真配置文件与真笔记目录，验证那些纯函数测不到的事——
 * **正文只走 stdout、提示语只走 stderr**，以及「拿不准就不猜」这条承诺。
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NoteFrontmatter, NoteSummary } from '../src/core/contracts.js';
import { EXIT } from '../src/core/errors.js';
import type { ExitCode } from '../src/core/errors.js';
import { renderNote } from '../src/core/render.js';
import { renderCandidates, runShowCommand, selectNotes } from '../src/commands/show.js';
import { ensureVaultLayout, fileExists, vaultPaths, writeNote } from '../src/io/vault.js';
import type { VaultPaths } from '../src/io/vault.js';

const root = mkdtempSync(join(tmpdir(), 'learnmate-show-'));
after(() => rmSync(root, { recursive: true, force: true }));

const HASH_A = 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e';
const INPUT_A = '01M3NRXP9V35CYARGJW9FR9F31';

/** 真实数据里的两个 id8（各被十几篇笔记共用），用来复现「id8 不是句柄」。 */
const COLLIDING_ID8 = '01M3NR4J';
const OTHER_ID8 = '01M3NRXY';

/** `<id8><16 个 0><2 位序号>`，26 位、ULID 字符集之内、序号用 0-9A-Z 避开 I/L/O/U。 */
function idWithId8(id8: string, index: number): string {
  return `${id8}${'0'.repeat(16)}${index.toString(36).toUpperCase().padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 摘要夹具（纯函数用例用，不落盘）
 * ------------------------------------------------------------------ */

function summary(
  overrides: Partial<NoteFrontmatter> & { relativePath?: string } = {},
): NoteSummary {
  const { relativePath, ...fields } = overrides;
  const id = fields.id ?? idWithId8(OTHER_ID8, 1);
  const frontmatter: NoteFrontmatter = {
    id,
    input_id: INPUT_A,
    title: 'AE 工程图层顺序',
    created: '2026-09-29T13:06:20+08:00',
    updated: '2026-09-29T13:06:20+08:00',
    summary: '摘要。',
    tags: ['AE'],
    status: 'processed',
    source_hash: HASH_A,
    source_ref: '示例输入.txt',
    schema_version: 1,
    language: 'zh',
    model: 'deepseek-chat',
    prompt_version: 'analyze.v1',
    ...fields,
  };
  return {
    path: `C:/vault/notes/${id}.md`,
    relativePath: relativePath ?? `notes/${id}.md`,
    frontmatter,
  };
}

function broken(fileName: string): NoteSummary {
  return {
    path: `C:/vault/notes/${fileName}`,
    relativePath: `notes/${fileName}`,
    frontmatter: null,
    problem: '文件不是以 --- 开头，没有 frontmatter',
  };
}

/* ------------------------------------------------------------------ *
 * selectNotes：匹配规则
 * ------------------------------------------------------------------ */

describe('selectNotes：26 位 id 走精确匹配', () => {
  const notes = [summary(), summary({ id: idWithId8(OTHER_ID8, 2) })];

  it('大小写不敏感，命中就是这一篇', () => {
    const hit = selectNotes(notes, idWithId8(OTHER_ID8, 1).toLowerCase());
    assert.deepEqual(hit.map((s) => s.frontmatter?.id), [idWithId8(OTHER_ID8, 1)]);
  });

  it('26 位但库里没有这个 id 时返回空——不退回子串搜，给了 id 的人意图很明确', () => {
    assert.deepEqual(selectNotes(notes, '01ZZZZZZZZZZZZZZZZZZZZZZZZ'), []);
  });
});

describe('selectNotes：子串匹配文件名与标题', () => {
  const notes = [
    summary({ id: idWithId8(OTHER_ID8, 1), title: 'AE 工程图层顺序' }),
    summary({
      id: idWithId8(OTHER_ID8, 2),
      title: '边缘光插件安装',
      relativePath: 'notes/AE-边缘光插件安装-01m3nrxy.md',
    }),
  ];

  it('标题里含关键词就命中', () => {
    assert.equal(selectNotes([summary({ title: '工程图层顺序' })], '工程图层').length, 1);
  });

  it('文件名去掉 .md 之后也参与匹配', () => {
    const hit = selectNotes(notes, 'AE-边缘光插件安装-01m3nrxy');
    assert.deepEqual(hit.map((s) => s.frontmatter?.id), [idWithId8(OTHER_ID8, 2)]);
  });

  it('大小写不敏感', () => {
    assert.equal(selectNotes(notes, 'ae').length, 2);
  });

  it('完全相等优先于子串：`show AE` 命中 2 篇，`show AE-边缘光插件安装-01m3nrxy` 只命中 1 篇', () => {
    assert.equal(selectNotes(notes, 'AE').length, 2);
    assert.equal(selectNotes(notes, 'AE-边缘光插件安装-01m3nrxy').length, 1);
  });

  it('读不懂 frontmatter 的笔记照样能被文件名命中（坏文件也看得见）', () => {
    const hit = selectNotes([broken('AE-某个坏文件-01m3nrzz.md')], '某个坏文件');
    assert.equal(hit.length, 1);
    assert.equal(hit[0]?.frontmatter, null);
  });

  it('空关键词（或只有空格）不命中任何东西', () => {
    assert.deepEqual(selectNotes(notes, ''), []);
    assert.deepEqual(selectNotes(notes, '   '), []);
  });

  it('只筛选、不排序：返回顺序与输入顺序一致', () => {
    const ordered = [
      summary({ id: idWithId8(OTHER_ID8, 3), title: 'AE 第三' }),
      summary({ id: idWithId8(OTHER_ID8, 1), title: 'AE 第一' }),
    ];
    assert.deepEqual(
      selectNotes(ordered, 'AE').map((s) => s.frontmatter?.id),
      [idWithId8(OTHER_ID8, 3), idWithId8(OTHER_ID8, 1)],
    );
  });
});

/* ------------------------------------------------------------------ *
 * 候选清单
 * ------------------------------------------------------------------ */

describe('renderCandidates', () => {
  const thirteen = Array.from({ length: 13 }, (_, i) =>
    summary({ id: idWithId8(COLLIDING_ID8, i + 1), title: `AE 笔记 ${i + 1}` }),
  );

  it('开头说清命中了多少篇，并明说「没法确定」', () => {
    const output = renderCandidates('01m3nr4j', thirteen);
    assert.ok(output.startsWith('「01m3nr4j」命中了 13 篇，没法确定你要哪一篇：\n\n'), output);
  });

  it('最多列 10 条，其余折成一行提示', () => {
    const lines = renderCandidates('01m3nr4j', thirteen)
      .split('\n')
      .filter((line) => line !== '');
    // 1 行开头 + 10 行候选 + 1 行「还有 3 条」
    assert.equal(lines.length, 12);
    assert.equal(lines[11], '…… 还有 3 条，把关键词写长一点再试。');
  });

  it('候选行与 list 同一个格式（完整 26 位 id，不是 id8）', () => {
    const output = renderCandidates('AE', [summary({ tags: ['合成', 'AE'] })]);
    assert.ok(
      output.includes(`${idWithId8(OTHER_ID8, 1)}  processed  2026-09-29 13:06  AE 工程图层顺序  [AE/合成]`),
      output,
    );
  });

  it('不超过 10 条时不出现「还有 N 条」', () => {
    assert.ok(!renderCandidates('AE', thirteen.slice(0, 3)).includes('还有'));
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

function makeNote(paths: VaultPaths, id: string, title: string, tags: string[] = ['AE']): string {
  const created = '2026-09-29T13:06:20+08:00';
  const markdown = renderNote(
    {
      title,
      summary: `${title} 的摘要。`,
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
  return writeNote(paths, title, id, markdown);
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

/** 把 stdout / stderr 都换成字符串缓冲，跑完在 finally 里还回去。 */
function capture(run: () => ExitCode): Captured {
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
    return { code: run(), out, err };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe('runShowCommand', () => {
  it('唯一命中：stdout 只有正文（以 # 开头、不含 ---），stderr 是空的，退出码 0', () => {
    const paths = freshVault();
    makeNote(paths, idWithId8(OTHER_ID8, 1), '工程图层顺序', ['AE', '合成']);
    const configDir = configDirFor(paths.root);

    const { code, out, err } = capture(() => runShowCommand('工程图层', { baseDir: configDir }));

    assert.equal(code, EXIT.OK);
    assert.ok(out.startsWith('# 工程图层顺序\n'), out);
    assert.ok(!out.includes('---'), '默认模式不该看到 frontmatter 的分隔线');
    assert.ok(!out.includes('id:'), '默认模式不该看到 id');
    assert.equal(err, '');
  });

  it('--raw：连 frontmatter 一起打，开头是 --- 和 id:', () => {
    const paths = freshVault();
    const id = idWithId8(OTHER_ID8, 1);
    makeNote(paths, id, '工程图层顺序');
    const configDir = configDirFor(paths.root);

    const { code, out } = capture(() =>
      runShowCommand('工程图层', { baseDir: configDir, raw: true }),
    );

    assert.equal(code, EXIT.OK);
    assert.ok(out.startsWith('---\n'), out);
    assert.ok(out.includes(`id: ${id}`), out);
    assert.ok(out.includes('# 工程图层顺序'), out);
  });

  it('一篇都没匹配上：退出码 2，stdout 空，stderr 里给出下一步', () => {
    const paths = freshVault();
    makeNote(paths, idWithId8(OTHER_ID8, 1), '工程图层顺序');
    const configDir = configDirFor(paths.root);

    const { code, out, err } = capture(() => runShowCommand('完全不存在的词', { baseDir: configDir }));

    assert.equal(code, EXIT.USAGE);
    assert.equal(out, '');
    assert.ok(err.includes('没有匹配的笔记'), err);
    assert.ok(err.includes('node dist/main.js list'), err);
  });

  it('命中多篇：退出码 2，候选走 stderr，stdout 里一个字都没有（绝不猜）', () => {
    const paths = freshVault();
    makeNote(paths, idWithId8(OTHER_ID8, 1), 'AE 工程图层顺序');
    makeNote(paths, idWithId8(OTHER_ID8, 2), 'AE 边缘光插件安装');
    const configDir = configDirFor(paths.root);

    const { code, out, err } = capture(() => runShowCommand('AE', { baseDir: configDir }));

    assert.equal(code, EXIT.USAGE);
    assert.equal(out, '', '拿不准的时候正文一个字都不能打');
    assert.ok(err.includes('「AE」命中了 2 篇，没法确定你要哪一篇：'), err);
    assert.ok(err.includes('AE 工程图层顺序'), err);
    assert.ok(err.includes('AE 边缘光插件安装'), err);
  });

  it('id8 不是句柄：13 篇共用一个 id8 时给出 13 条候选（真实数据的形状）', () => {
    const paths = freshVault();
    for (let i = 1; i <= 13; i += 1) {
      makeNote(paths, idWithId8(COLLIDING_ID8, i), `素材整理 ${i}`);
    }
    const configDir = configDirFor(paths.root);

    const { code, out, err } = capture(() => runShowCommand(COLLIDING_ID8.toLowerCase(), { baseDir: configDir }));

    assert.equal(code, EXIT.USAGE);
    assert.equal(out, '');
    assert.ok(err.includes('命中了 13 篇'), err);
    assert.ok(err.includes('…… 还有 3 条，把关键词写长一点再试。'), err);
  });

  it('拿 id8 当关键词时走的是「文件名子串」，库小时照样能唯一定位（id8 只是不再是句柄）', () => {
    const paths = freshVault();
    makeNote(paths, idWithId8(COLLIDING_ID8, 1), '素材整理 1');
    const configDir = configDirFor(paths.root);

    // 8 个字符不是 26 位，所以不会走 id 精确匹配；命中的是文件名里那一段。
    // 这正是「想按名字查的路没堵死」：小库里好用，库里一多就退化成候选清单。
    const { code, out, err } = capture(() =>
      runShowCommand(COLLIDING_ID8.toLowerCase(), { baseDir: configDir }),
    );

    assert.equal(code, EXIT.OK);
    assert.ok(out.includes('# 素材整理 1'), out);
    assert.equal(err, '');
  });

  it('frontmatter 读不懂时：正文照样打出来，但先往 stderr 说一句', () => {
    const paths = freshVault();
    const fileName = 'AE-某个坏文件-01m3nrzz.md';
    writeFileSync(
      join(paths.notesDir, fileName),
      '# 一篇手工写的笔记\n\nfrontmatter 坏了，但正文还在。\n',
      'utf8',
    );
    const configDir = configDirFor(paths.root);

    const { code, out, err } = capture(() => runShowCommand('某个坏文件', { baseDir: configDir }));

    assert.equal(code, EXIT.OK);
    assert.ok(out.includes('frontmatter 坏了，但正文还在。'), out);
    assert.ok(err.includes('frontmatter 读不懂'), err);
  });

  it('只读：知识库不存在时不创建它', () => {
    const missing = join(root, '还没有的知识库');
    const configDir = configDirFor(missing);

    const { code, err } = capture(() => runShowCommand('随便什么', { baseDir: configDir }));

    assert.equal(code, EXIT.USAGE);
    assert.ok(!fileExists(missing), 'show 不该创建知识库目录');
    assert.ok(err.includes('没有匹配的笔记'), err);
  });

  it('不写任何文件：跑完 notes/ 内容一字不变', () => {
    const paths = freshVault();
    makeNote(paths, idWithId8(OTHER_ID8, 1), '工程图层顺序');
    const configDir = configDirFor(paths.root);
    const before = readdirSync(paths.notesDir).sort();

    capture(() => runShowCommand('工程图层', { baseDir: configDir }));
    capture(() => runShowCommand('工程图层', { baseDir: configDir, raw: true }));

    assert.deepEqual(readdirSync(paths.notesDir).sort(), before);
  });
});
