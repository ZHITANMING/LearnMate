import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { UsageError } from '../src/core/errors.js';
import {
  draftFilePath,
  ensureVaultLayout,
  fileExists,
  listDraftFiles,
  listResolutionFiles,
  moveNoteToTrash,
  noteFilePath,
  rawFilePath,
  readDraft,
  readRaw,
  readResolutions,
  resolutionFilePath,
  trashFilePath,
  vaultPaths,
  writeDraft,
  writeNote,
  writeRaw,
  writeResolutions,
  writeTextAtomic,
  type VaultPaths,
} from '../src/io/vault.js';
import { noteFileName, slugify, SLUG_MAX_LENGTH } from '../src/util/slug.js';

/**
 * 测试用的假 id。必须是合法 ULID（26 个大写 Crockford 字符，不含 I / L / O / U），
 * 否则会被 `assertUlid` 拦下来——那是故意的。
 */
const ID_A = '01J8ZK4M2Q7V9N3P5R7T9W2X4Y';
const ID_B = '01J8ZK4M2Q7V9N3P5R7T9W2X4Z';
const ID_C = '01J8ZQ7V9N3P5R7T9W2X4Y6B8D';

/** 每个用例一个独立的临时知识库，跑完统一删掉。 */
const tempRoots: string[] = [];

function tempVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'learnmate-vault-'));
  tempRoots.push(root);
  return vaultPaths(root);
}

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 目录里剩下的、形如临时文件的垃圾。正常情况下永远是空的。 */
function leftoverTempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

describe('slugify —— 文件名清洗（契约第 5.3 节）', () => {
  it('普通标题原样保留', () => {
    assert.equal(slugify('工具基础设置'), '工具基础设置');
  });

  it('删掉 Windows 非法字符', () => {
    assert.equal(slugify('a:b*c?d"e<f>g|h/i\\j'), 'abcdefghij');
  });

  it('删掉换行、制表符等控制字符', () => {
    assert.equal(slugify('第一行\n第二行\t结束'), '第一行第二行结束');
  });

  it('空白与下划线都变成一个 `-`', () => {
    assert.equal(slugify('素材 加 边缘光_提取'), '素材-加-边缘光-提取');
  });

  it('连续 `-` 折叠成一个', () => {
    assert.equal(slugify('素材---加边缘光'), '素材-加边缘光');
  });

  it('去掉首尾的 `-`', () => {
    assert.equal(slugify('---素材加边缘光---'), '素材加边缘光');
  });

  it('中文、日文、括号原样保留', () => {
    assert.equal(slugify('素材加边缘光（提取 + 乙插件）'), '素材加边缘光（提取-+-乙插件）');
  });

  it('Windows 保留名前置 `n-`', () => {
    assert.equal(slugify('CON'), 'n-CON');
    assert.equal(slugify('nul'), 'n-nul');
    assert.equal(slugify('Aux'), 'n-Aux');
    assert.equal(slugify('com1'), 'n-com1');
    assert.equal(slugify('LPT9'), 'n-LPT9');
  });

  it('长得像保留名但不是的，不许误伤', () => {
    assert.equal(slugify('console'), 'console');
    assert.equal(slugify('COM0'), 'COM0');
    assert.equal(slugify('COM10'), 'COM10');
  });

  it('空标题、纯空白、纯非法字符都兜底成 note', () => {
    assert.equal(slugify(''), 'note');
    assert.equal(slugify('   '), 'note');
    assert.equal(slugify('::*?'), 'note');
    assert.equal(slugify('---'), 'note');
  });

  it('超长标题按码点截断到 60 个字符', () => {
    assert.equal([...slugify('字'.repeat(200))].length, SLUG_MAX_LENGTH);
  });

  it('截断不切开 emoji（代理对）', () => {
    const slug = slugify('🎨'.repeat(70));
    assert.equal([...slug].length, SLUG_MAX_LENGTH);
    assert.equal(slug, '🎨'.repeat(SLUG_MAX_LENGTH));
  });

  it('截断后不会留下结尾的 `-`', () => {
    const slug = slugify(`${'a'.repeat(SLUG_MAX_LENGTH - 1)} 尾巴`);
    assert.ok(!slug.endsWith('-'), `不该以 - 结尾，实际是 ${JSON.stringify(slug)}`);
  });

  it('幂等：清洗过的再清洗一次不变', () => {
    for (const title of ['工具基础设置', 'CON', '素材加边缘光（提取 + 乙插件）', ':::']) {
      assert.equal(slugify(slugify(title)), slugify(title));
    }
  });
});

describe('noteFileName —— `<slug>-<id8>.md`（契约第 5.3 节）', () => {
  it('拼出 slug 加小写的 id 前 8 位', () => {
    assert.equal(noteFileName('工具基础设置', ID_A), '工具基础设置-01j8zk4m.md');
  });

  it('标题为空也安全', () => {
    assert.equal(noteFileName('', ID_A), 'note-01j8zk4m.md');
  });

  it('标题一样但 id 不同，文件名不会撞车', () => {
    assert.notEqual(noteFileName('工具基础设置', ID_A), noteFileName('工具基础设置', ID_C));
  });
});

describe('vaultPaths / ensureVaultLayout —— 知识库骨架（契约第 2 节）', () => {
  it('全部路径都在根目录下面', () => {
    const paths = vaultPaths('C:\\kb');
    for (const value of Object.values(paths)) {
      assert.ok(value.startsWith('C:\\kb'), `${value} 不在 vault 根目录下`);
    }
  });

  it('notes/ 与 .learnmate/ 各就各位', () => {
    const paths = vaultPaths(join('somewhere', 'kb'));
    assert.ok(paths.notesDir.endsWith(join('kb', 'notes')));
    assert.ok(paths.rawDir.endsWith(join('.learnmate', 'raw')));
    assert.ok(paths.ledgerFile.endsWith(join('.learnmate', 'ledger.jsonl')));
  });

  it('建骨架：七个目录一个不少', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    for (const dir of [
      paths.notesDir,
      paths.metaDir,
      paths.rawDir,
      paths.draftDir,
      paths.resolutionsDir,
      paths.quarantineDir,
      paths.trashDir,
    ]) {
      assert.ok(existsSync(dir), `${dir} 没有被建出来`);
    }
  });

  it('骨架是幂等的，连建两次不报错', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    ensureVaultLayout(paths);
  });
});

describe('writeTextAtomic —— 原子写入（契约第 6.4 节）', () => {
  it('写进去的内容能原样读回来', () => {
    const paths = tempVault();
    const target = join(paths.notesDir, 'a.md');
    writeTextAtomic(target, '# 标题\n');
    assert.equal(existsSync(target), true);
    assert.deepEqual(readdirSync(paths.notesDir), ['a.md']);
  });

  it('目标已存在时覆盖，不是追加', () => {
    const paths = tempVault();
    const target = join(paths.notesDir, 'a.md');
    writeTextAtomic(target, '第一版');
    writeTextAtomic(target, '第二版');
    assert.equal(readFile(target), '第二版');
  });

  it('目录不存在会自动建出来', () => {
    const paths = tempVault();
    const target = join(paths.rawDir, 'deep', 'nested.txt');
    writeTextAtomic(target, 'hi');
    assert.equal(readFile(target), 'hi');
  });

  it('写完不留临时文件', () => {
    const paths = tempVault();
    writeTextAtomic(join(paths.notesDir, 'a.md'), 'x');
    assert.deepEqual(leftoverTempFiles(paths.notesDir), []);
  });

  it('失败时把临时文件清掉，不留下半个文件', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);

    // 让目标位置被一个非空目录占着，改名一定会失败。
    const taken = join(paths.notesDir, 'taken.md');
    mkdirSync(taken);
    writeFileSync(join(taken, '挡路的.txt'), 'x');

    assert.throws(() => writeTextAtomic(taken, 'hi'), /写不了文件/);
    assert.deepEqual(readdirSync(paths.notesDir), ['taken.md']);
  });
});

describe('raw / draft / notes 三个具名入口', () => {
  it('原文写进 raw/<input_id>.txt，读得回来', () => {
    const paths = tempVault();
    const filePath = writeRaw(paths, ID_A, '甲：矢量软件；乙：位图软件。\n');
    assert.equal(basename(filePath), `${ID_A}.txt`);
    assert.equal(readRaw(paths, ID_A), '甲：矢量软件；乙：位图软件。\n');
  });

  it('草稿写进 draft/<input_id>.json，是带缩进的合法 JSON', () => {
    const paths = tempVault();
    const filePath = writeDraft(paths, ID_A, { notes: [{ title: '工具基础设置' }] });
    assert.equal(basename(filePath), `${ID_A}.json`);
    assert.deepEqual(JSON.parse(readDraft(paths, ID_A)), {
      notes: [{ title: '工具基础设置' }],
    });
    assert.ok(readDraft(paths, ID_A).endsWith('\n'), '文本文件末尾应当有换行');
  });

  it('模型返回的垃圾也照原样留着（这是查问题的唯一线索）', () => {
    const paths = tempVault();
    writeDraft(paths, ID_A, { 这: '不是契约里的形状' });
    assert.ok(readDraft(paths, ID_A).includes('不是契约里的形状'));
  });

  it('笔记写进 notes/，文件名由标题和 id 决定', () => {
    const paths = tempVault();
    const filePath = writeNote(paths, '工具基础设置', ID_A, '# 工具基础设置\n');
    assert.equal(basename(filePath), '工具基础设置-01j8zk4m.md');
    assert.equal(readFile(filePath), '# 工具基础设置\n');
  });

  it('fileExists 分得清「有文件」和「没文件」', () => {
    const paths = tempVault();
    assert.equal(fileExists(join(paths.notesDir, '不存在的.md')), false);
    writeNote(paths, 'x', ID_A, 'x');
    assert.equal(fileExists(noteFilePath(paths, 'x', ID_A)), true);
  });
});

describe('用户起什么标题都得存得进去（T5 的验收点）', () => {
  it('标题里塞满 Windows 非法字符，照样落盘', () => {
    const paths = tempVault();
    const nasty = '甲: 素材*导出?"<边缘光>|/ 测试';
    const filePath = writeNote(paths, nasty, ID_A, '# 内容\n');

    assert.ok(existsSync(filePath), `${filePath} 没有落盘`);
    assert.ok(
      !/[:*?"<>|]/.test(basename(filePath)),
      `文件名里还有非法字符：${basename(filePath)}`,
    );
  });

  it('标题就叫 CON，落盘后名字是 n-CON-...', () => {
    const paths = tempVault();
    const filePath = writeNote(paths, 'CON', ID_A, '# 内容\n');
    assert.ok(existsSync(filePath), `${filePath} 没有落盘`);
    assert.ok(basename(filePath).startsWith('n-CON-'), basename(filePath));
  });

  it('标题是超长中文，文件名长度可控', () => {
    const paths = tempVault();
    const filePath = writeNote(paths, '很长的标题'.repeat(50), ID_A, '# 内容\n');
    assert.ok(existsSync(filePath));
    assert.ok([...basename(filePath)].length <= SLUG_MAX_LENGTH + '-01j8zk4m.md'.length);
  });
});

describe('拼路径之前挡住路径穿越', () => {
  it('input_id 里混进 `../` 会被拦下', () => {
    const paths = tempVault();
    assert.throws(() => rawFilePath(paths, '../../evil'), UsageError);
    assert.throws(() => draftFilePath(paths, '../../../etc/passwd'), UsageError);
  });

  it('笔记 id 不是 ULID 就报错', () => {
    const paths = tempVault();
    assert.throws(() => noteFilePath(paths, '标题', 'not-a-ulid'), UsageError);
    assert.throws(() => noteFilePath(paths, '标题', ID_A.slice(0, 25)), UsageError);
    // 小写不是契约里的形状：让 bug 响亮地暴露，好过悄悄生成两个不同的 id
    assert.throws(() => noteFilePath(paths, '标题', ID_A.toLowerCase()), UsageError);
  });

  it('回收站只收文件名，传路径进来会被削平', () => {
    const paths = tempVault();
    const filePath = trashFilePath(paths, '../../x.md');
    assert.equal(dirname(filePath), paths.trashDir);
    assert.equal(basename(filePath), 'x.md');
  });
});

describe('resolutions/ 与 trash/ —— 裁定落盘与回收站（T13）', () => {
  it('ensureVaultLayout 建出 resolutions/，重复调用也不报错', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    ensureVaultLayout(paths);
    assert.ok(existsSync(paths.resolutionsDir));
  });

  it('裁定文件读写往返：路径按 input_id 命名，末尾带换行', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);

    const payload = {
      input_id: ID_A,
      ts: '2026-09-30T12:00:00+08:00',
      notes: [{ note_index: 1, items: [{ item_index: 1, text: '存疑', action: 'drop' }] }],
    };

    const filePath = writeResolutions(paths, ID_A, payload);
    assert.equal(filePath, resolutionFilePath(paths, ID_A));
    assert.equal(basename(filePath), `${ID_A}.json`);
    assert.equal(dirname(filePath), paths.resolutionsDir);

    const raw = readResolutions(paths, ID_A);
    assert.ok(raw.endsWith('\n'));
    assert.deepEqual(JSON.parse(raw), payload);
  });

  it('读不存在的裁定文件会抛错——「读不到」和「没裁定」是两件事', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    assert.throws(() => readResolutions(paths, ID_B));
  });

  it('listResolutionFiles 只列 resolutions/ 里的文件', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    writeResolutions(paths, ID_A, { input_id: ID_A, ts: 'x', notes: [] });
    writeDraft(paths, ID_B, { notes: [] });

    assert.deepEqual(
      listResolutionFiles(paths).map((filePath) => basename(filePath)),
      [`${ID_A}.json`],
    );
  });

  it('listDraftFiles 不会把裁定文件当成草稿', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    writeDraft(paths, ID_A, { notes: [] });
    writeResolutions(paths, ID_B, { input_id: ID_B, ts: 'x', notes: [] });

    assert.deepEqual(
      listDraftFiles(paths).map((filePath) => basename(filePath)),
      [`${ID_A}.json`],
    );
  });

  it('moveNoteToTrash：笔记从 notes/ 搬进 trash/，内容一个字不变', () => {
    const paths = tempVault();
    const markdown = '---\nid: x\n---\n\n正文。\n';
    const notePath = writeNote(paths, '导出清晰', ID_A, markdown);
    const fileName = basename(notePath);

    const moved = moveNoteToTrash(paths, fileName);

    assert.equal(existsSync(notePath), false, 'notes/ 里不该还留着');
    assert.equal(fileExists(moved), true);
    assert.equal(dirname(moved), paths.trashDir);
    assert.equal(basename(moved), fileName);
    assert.equal(readFile(moved), markdown);
  });

  it('moveNoteToTrash：trash/ 里已经有同名文件时加 .<n> 后缀，n 从 1 起', () => {
    const paths = tempVault();
    const markdown = '# 正文\n';
    const notePath = writeNote(paths, '导出清晰', ID_A, markdown);
    const fileName = basename(notePath);

    const first = moveNoteToTrash(paths, fileName);
    writeNote(paths, '导出清晰', ID_A, markdown);
    const second = moveNoteToTrash(paths, fileName);
    writeNote(paths, '导出清晰', ID_A, markdown);
    const third = moveNoteToTrash(paths, fileName);

    assert.equal(basename(first), fileName);
    assert.equal(basename(second), `${fileName.slice(0, -3)}.1.md`);
    assert.equal(basename(third), `${fileName.slice(0, -3)}.2.md`);
    assert.equal(fileExists(first), true, '不盖掉上一次搬进去的那份');
    assert.equal(fileExists(second), true);
    assert.equal(fileExists(third), true);
  });

  it('moveNoteToTrash：notes/ 里没有这个文件就报错，不凭空造一个', () => {
    const paths = tempVault();
    ensureVaultLayout(paths);
    assert.throws(() => moveNoteToTrash(paths, '没有这篇-01j8zk4m.md'));
    assert.deepEqual(readdirSync(paths.trashDir), []);
  });
});

/** 读文件的小助手（测试里绕过 vault 的包装直接读，免得拿被测代码印证自己）。 */
function readFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}
