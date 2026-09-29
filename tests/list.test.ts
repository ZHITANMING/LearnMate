/**
 * `learnmate list` 的测试。
 *
 * 大部分用例直接调**纯渲染函数** `renderNoteList`：这一层的职责就是「给一堆摘要，
 * 决定打出哪几行字」，用字符串断言最直接，也最容易看出格式改坏了什么。
 *
 * 少数几个用例走完整的 `runListCommand`（真配置文件、真知识库目录），为的是验证
 * 那些纯函数测不到的东西：**只读、零写入**，以及「台账删掉了照样列得出来」。
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LedgerNoteRow, NoteFrontmatter, NoteSummary } from '../src/core/contracts.js';
import { EXIT, UsageError } from '../src/core/errors.js';
import type { ExitCode } from '../src/core/errors.js';
import { renderNote } from '../src/core/render.js';
import { parseStatusOption, renderNoteList, runListCommand } from '../src/commands/list.js';
import { appendEntries } from '../src/io/ledger.js';
import { ensureVaultLayout, fileExists, vaultPaths, writeNote } from '../src/io/vault.js';
import type { VaultPaths } from '../src/io/vault.js';

const root = mkdtempSync(join(tmpdir(), 'learnmate-list-'));
after(() => rmSync(root, { recursive: true, force: true }));

const HASH_A = 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e';
const INPUT_A = '01M3NRXP9V35CYARGJW9FR9F31';

/** 26 位、ULID 形状的假 id：`01M3NRXY` + 16 个 0 + 2 位序号。 */
function fakeId(index: number): string {
  return `01M3NRXY${'0'.repeat(16)}${String(index).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 摘要夹具（纯函数用例用，不落盘）
 * ------------------------------------------------------------------ */

function frontmatter(overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter {
  return {
    id: '01M3NRXYPSEJ8PY09XTSZ5S4YA',
    input_id: INPUT_A,
    title: 'AE 工程图层顺序',
    created: '2026-09-29T13:06:20+08:00',
    updated: '2026-09-29T13:06:20+08:00',
    summary: '摘要。',
    tags: ['合成', 'AE', '界面'],
    status: 'processed',
    source_hash: HASH_A,
    source_ref: '示例输入.txt',
    schema_version: 1,
    language: 'zh',
    model: 'deepseek-chat',
    prompt_version: 'analyze.v1',
    ...overrides,
  };
}

function readable(overrides: Partial<NoteFrontmatter> = {}): NoteSummary {
  const fields = frontmatter(overrides);
  return {
    path: `C:/vault/notes/${fields.id}.md`,
    relativePath: `notes/${fields.id}.md`,
    frontmatter: fields,
  };
}

function unreadable(fileName: string, problem = 'frontmatter 第 3 行不是 `键: 值`'): NoteSummary {
  return {
    path: `C:/vault/notes/${fileName}`,
    relativePath: `notes/${fileName}`,
    frontmatter: null,
    problem,
  };
}

/** 只取笔记行，丢掉末尾那行统计。 */
function noteLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .filter((line) => !line.startsWith('共 ') && !line.startsWith('符合这个条件的共 '));
}

/* ------------------------------------------------------------------ *
 * 输出格式
 * ------------------------------------------------------------------ */

describe('renderNoteList：一行一篇', () => {
  it('假 id 真的是 26 位（下面那些断言都靠它）', () => {
    assert.equal(fakeId(1).length, 26);
  });

  it('字段用两个空格分隔，标签按 UTF-16 升序，末尾一行统计', () => {
    const output = renderNoteList([readable()]);

    assert.equal(
      output,
      '01M3NRXYPSEJ8PY09XTSZ5S4YA  processed  2026-09-29 13:06  AE 工程图层顺序  [AE/合成/界面]\n' +
        '共 1 篇。\n',
    );
  });

  it('中文标题不影响分隔（不用 padEnd 对齐）', () => {
    const lines = noteLines(
      renderNoteList([readable(), readable({ id: fakeId(1), title: '短' })]),
    );

    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.split('  ').length, 5, `每行正好 5 段：${line}`);
    }
  });

  it('标签为空时方括号里也是空的', () => {
    assert.ok(renderNoteList([readable({ tags: [] })]).includes('  []'), '空标签就该是 []');
  });

  it('created 只取前 16 个字符，T 换成空格', () => {
    const output = renderNoteList([readable({ created: '2026-09-29T13:06:20.123+08:00' })]);
    assert.ok(output.includes('  2026-09-29 13:06  '), output);
  });

  it('读不懂的行带上文件名和原因', () => {
    const output = renderNoteList([unreadable('AE-某个坏文件-01m3nrzz.md')]);
    assert.ok(
      output.startsWith('（读不懂）  AE-某个坏文件-01m3nrzz.md  ——  frontmatter 第 3 行不是 `键: 值`'),
      output,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 排序
 * ------------------------------------------------------------------ */

describe('renderNoteList：排序确定，不看时钟', () => {
  it('created 新的在前，同一时刻按 id 升序', () => {
    const output = renderNoteList([
      readable({ id: fakeId(3), created: '2026-09-29T12:52:00+08:00' }),
      readable({ id: fakeId(2), created: '2026-09-29T13:06:20+08:00' }),
      readable({ id: fakeId(1), created: '2026-09-29T13:06:20+08:00' }),
    ]);

    assert.deepEqual(
      noteLines(output).map((line) => line.slice(0, 26)),
      [fakeId(1), fakeId(2), fakeId(3)],
    );
  });

  it('读不懂的永远排最后，彼此按文件名升序，并在统计行里报数', () => {
    const lines = renderNoteList([
      unreadable('zzz-坏文件.md'),
      readable(),
      unreadable('aaa-坏文件.md'),
    ])
      .split('\n')
      .filter((line) => line !== '');

    assert.equal(lines.length, 4);
    assert.ok(lines[0]?.startsWith('01M3NRXYPSEJ8PY09XTSZ5S4YA'), `${lines[0] ?? ''}`);
    assert.ok(lines[1]?.startsWith('（读不懂）  aaa-坏文件.md  ——  '), `${lines[1] ?? ''}`);
    assert.ok(lines[2]?.startsWith('（读不懂）  zzz-坏文件.md  ——  '), `${lines[2] ?? ''}`);
    assert.equal(
      lines[3],
      '共 3 篇；其中 2 篇读不懂（frontmatter 坏了，文件还在，用 `type` 直接看）。',
    );
  });

  it('同一份输入跑两次，输出逐字节相同', () => {
    const summaries = [readable(), unreadable('坏.md'), readable({ id: fakeId(1) })];
    assert.equal(renderNoteList(summaries), renderNoteList(summaries));
  });
});

/* ------------------------------------------------------------------ *
 * 过滤
 * ------------------------------------------------------------------ */

describe('renderNoteList：--tag / --status', () => {
  const notes = [
    readable({ id: fakeId(1), tags: ['AE'], status: 'processed' }),
    readable({ id: fakeId(2), tags: ['ae'], status: 'inbox' }),
    readable({ id: fakeId(3), tags: ['合成'], status: 'inbox' }),
  ];

  it('--tag 大小写不敏感：AE 与 ae 结果完全相同', () => {
    const upper = renderNoteList(notes, { tag: 'AE' });
    const lower = renderNoteList(notes, { tag: 'ae' });

    assert.equal(upper, lower);
    assert.equal(noteLines(upper).length, 2);
  });

  it('--status 只留该状态', () => {
    assert.deepEqual(
      noteLines(renderNoteList(notes, { status: 'inbox' })).map((line) => line.slice(0, 26)),
      [fakeId(2), fakeId(3)],
    );
  });

  it('两个过滤叠加是「且」', () => {
    assert.deepEqual(
      noteLines(renderNoteList(notes, { tag: 'ae', status: 'inbox' })).map((line) => line.slice(0, 26)),
      [fakeId(2)],
    );
  });

  it('带过滤时读不懂的笔记不出现（它没有可用来匹配的字段）', () => {
    const output = renderNoteList([...notes, unreadable('坏.md')], { tag: 'AE' });
    assert.equal(noteLines(output).length, 2);
    assert.ok(!output.includes('（读不懂）'), output);
  });

  it('过滤后 0 条不是错误，只打印一行说明', () => {
    assert.equal(
      renderNoteList(notes, { tag: '不存在的标签' }),
      '没有符合这个条件的笔记（库里有 3 篇）。\n',
    );
  });

  it('带过滤时统计行说明是全库里的几篇', () => {
    assert.ok(
      renderNoteList(notes, { tag: 'AE' }).endsWith('符合这个条件的共 2 篇（库里 3 篇）。\n'),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 空知识库 / 非法选项
 * ------------------------------------------------------------------ */

describe('renderNoteList：空知识库', () => {
  it('空库打印两行引导——新用户第一次跑看到的就是它', () => {
    assert.equal(
      renderNoteList([]),
      '知识库还是空的（还没有录入过任何笔记）。\n' +
        '先跑 node dist/main.js doctor 看看配置，再用 add 录入第一份材料。\n',
    );
  });

  it('空库带过滤也还是这两行——「库里一篇都没有」比「没匹配上」更贴近事实', () => {
    assert.equal(renderNoteList([], { tag: 'AE' }), renderNoteList([]));
  });
});

describe('parseStatusOption', () => {
  it('三种合法状态原样返回，不给就是 undefined', () => {
    assert.equal(parseStatusOption('inbox'), 'inbox');
    assert.equal(parseStatusOption('processed'), 'processed');
    assert.equal(parseStatusOption('reviewed'), 'reviewed');
    assert.equal(parseStatusOption(undefined), undefined);
  });

  it('别的值报用法错误、退出码 2，不许静默当成 0 条', () => {
    assert.throws(
      () => parseStatusOption('done'),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.ok(error.message.includes('inbox | processed | reviewed'), error.message);
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ *
 * 完整命令：只读、零写入、不依赖台账
 * ------------------------------------------------------------------ */

let vaultCounter = 0;
function freshVault(): VaultPaths {
  vaultCounter += 1;
  const paths = vaultPaths(join(root, `vault-${vaultCounter}`));
  ensureVaultLayout(paths);
  return paths;
}

/** 真的走一遍 render + vault 写入，产生磁盘上一个能读懂的笔记文件。 */
function makeNote(paths: VaultPaths, index: number, title: string, tags: string[]): string {
  const id = fakeId(index);
  const created = `2026-09-29T13:06:0${index}+08:00`;
  const markdown = renderNote(
    { title, summary: `${title} 的摘要。`, language: 'zh', tags, blocks: [{ type: 'text', text: '正文。' }] },
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

function okRow(id: string): LedgerNoteRow {
  return {
    ts: '2026-09-29T13:06:30+08:00',
    input_id: INPUT_A,
    id,
    note_index: 1,
    note_total: 1,
    source_hash: HASH_A,
    note_path: 'notes/whatever.md',
    title: '随便什么标题',
    tags: ['AE'],
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

/** 一个只够跑 `list` 的配置目录：不需要 API Key。 */
function configDirFor(vaultPath: string): string {
  const dir = mkdtempSync(join(root, 'cfg-'));
  writeFileSync(
    join(dir, 'learnmate.config.json'),
    JSON.stringify({ model: 'deepseek-chat', vaultPath }),
    'utf8',
  );
  return dir;
}

/** 把 stdout 换成一段字符串缓冲，跑完必须还回去。 */
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

describe('runListCommand', () => {
  it('列出真知识库，退出码 0，行首是完整 26 位 id', () => {
    const paths = freshVault();
    makeNote(paths, 1, '工程图层顺序', ['AE', '合成']);
    makeNote(paths, 2, '边缘光做法', ['AE', '边缘光']);
    const configDir = configDirFor(paths.root);

    const { code, out } = captureStdout(() => runListCommand({ baseDir: configDir }));

    assert.equal(code, EXIT.OK);
    assert.ok(out.includes('  工程图层顺序  [AE/合成]'), out);
    assert.ok(out.includes('共 2 篇。'), out);
    assert.equal(noteLines(out).length, 2);
    assert.ok(!out.includes('01m3nrxy'), '不该出现小写的 id8 前缀');
  });

  it('是只读的：不建目录、不改知识库', () => {
    const paths = freshVault();
    makeNote(paths, 1, '工程图层顺序', ['AE']);
    const configDir = configDirFor(paths.root);
    const before = readdirSync(paths.root).sort();

    const { code } = captureStdout(() => runListCommand({ baseDir: configDir }));

    assert.equal(code, EXIT.OK);
    assert.deepEqual(readdirSync(paths.root).sort(), before);
  });

  it('知识库还不存在时不创建它，直接说「还是空的」', () => {
    const missingVault = join(root, '还没有的知识库');
    const configDir = configDirFor(missingVault);

    const { code, out } = captureStdout(() => runListCommand({ baseDir: configDir }));

    assert.equal(code, EXIT.OK);
    assert.ok(out.startsWith('知识库还是空的'), out);
    assert.ok(!fileExists(missingVault), 'list 不该创建知识库目录');
  });

  it('台账整个删掉，照样列得出来（D37 的现场证据）', () => {
    const paths = freshVault();
    makeNote(paths, 1, '工程图层顺序', ['AE', '合成']);
    makeNote(paths, 2, '边缘光做法', ['AE', '边缘光']);
    appendEntries(paths, [okRow(fakeId(1))]);
    assert.ok(fileExists(paths.ledgerFile), '前置条件：台账本来存在');

    rmSync(paths.ledgerFile);

    const { code, out } = captureStdout(() =>
      runListCommand({ baseDir: configDirFor(paths.root) }),
    );
    assert.equal(code, EXIT.OK);
    assert.equal(noteLines(out).length, 2);
  });

  it('--status 给错值时抛用法错误（退出码 2），而且一个文件都不写', () => {
    const paths = freshVault();
    const configDir = configDirFor(paths.root);

    assert.throws(
      () => runListCommand({ baseDir: configDir, status: 'done' }),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.equal(error.exitCode, EXIT.USAGE);
        return true;
      },
    );
    assert.deepEqual(readdirSync(paths.notesDir), []);
  });

  it('过滤后 0 条仍然是退出码 0', () => {
    const paths = freshVault();
    makeNote(paths, 1, '工程图层顺序', ['AE']);
    const configDir = configDirFor(paths.root);

    const { code, out } = captureStdout(() =>
      runListCommand({ baseDir: configDir, status: 'inbox' }),
    );

    assert.equal(code, EXIT.OK);
    assert.equal(out, '没有符合这个条件的笔记（库里有 1 篇）。\n');
  });
});
