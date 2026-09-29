/**
 * 知识库文件系统。
 *
 * **这是全项目唯一被允许碰 `vault/` 目录的模块**（架构硬约束第 3 条）。别的模块
 * 想知道「笔记存在哪」「原文叫什么名字」，都必须问它，不许自己拼路径。这样
 * 「文件放在哪、叫什么名字」这件事只有一个地方知道，将来想改目录布局只改一个文件。
 *
 * 目录布局见 docs/03-contracts.md 第 2 节，原子写入见第 6.4 节。
 *
 * 本文件属于 io 层：允许碰文件、时钟、随机数。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { UsageError } from '../core/errors.js';
import { noteFileName } from '../util/slug.js';

/** `notes/`：唯一人类可见的产物，扁平目录，分类靠 frontmatter 的 tags。 */
export const NOTES_DIR = 'notes';

/** `.learnmate/`：以点开头，Obsidian 默认忽略。 */
export const META_DIR = '.learnmate';

/** `raw/`：规范化原文，按 `input_id` 存（一次输入只存一份）。 */
export const RAW_DIR = 'raw';

/** `draft/`：一次输入的全部草稿。 */
export const DRAFT_DIR = 'draft';

/** `quarantine/`：校验失败时的现场。 */
export const QUARANTINE_DIR = 'quarantine';

/**
 * `resolutions/`：用户对存疑项的 `d`/`e` 裁定（契约第 12 节）。
 *
 * 单独一个目录，**不放进 `draft/`**：`listFilesIn` 按扩展名过滤，
 * `xxx.resolutions.json` 会被 `listDraftFiles` 当成一份草稿。
 */
export const RESOLUTIONS_DIR = 'resolutions';

/** `trash/`：被换掉的笔记（回收站）。 */
export const TRASH_DIR = 'trash';

/** 台账文件名。 */
export const LEDGER_FILE_NAME = 'ledger.jsonl';

/** 知识库里全部路径的绝对路径集合。构造一次，到处传。 */
export interface VaultPaths {
  readonly root: string;
  readonly notesDir: string;
  readonly metaDir: string;
  readonly rawDir: string;
  readonly draftDir: string;
  readonly resolutionsDir: string;
  readonly quarantineDir: string;
  readonly trashDir: string;
  readonly ledgerFile: string;
}

/**
 * ULID：26 字符，Crockford Base32 大写（去掉了容易看错的 I / L / O / U）。
 * 契约第 5.2 节。
 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 从一个知识库根目录算出全部路径。**只算，不建目录、不碰磁盘。**
 * （建目录是 `ensureVaultLayout` 的事，读配置时不该顺手在磁盘上留东西。）
 */
export function vaultPaths(root: string): VaultPaths {
  const metaDir = join(root, META_DIR);
  return {
    root,
    notesDir: join(root, NOTES_DIR),
    metaDir,
    rawDir: join(metaDir, RAW_DIR),
    draftDir: join(metaDir, DRAFT_DIR),
    resolutionsDir: join(metaDir, RESOLUTIONS_DIR),
    quarantineDir: join(metaDir, QUARANTINE_DIR),
    trashDir: join(metaDir, TRASH_DIR),
    ledgerFile: join(metaDir, LEDGER_FILE_NAME),
  };
}

/**
 * 建出知识库的目录骨架。幂等，已有目录不会报错。
 *
 * 空目录不占地方也没有代价，而「第一次跑的时候哪一层不存在」是新手最常踩的坑，
 * 所以一次性全建出来，不用每个命令自己去想该建哪层。
 */
export function ensureVaultLayout(paths: VaultPaths): void {
  const dirs = [
    paths.notesDir,
    paths.metaDir,
    paths.rawDir,
    paths.draftDir,
    paths.resolutionsDir,
    paths.quarantineDir,
    paths.trashDir,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

/** `vault/.learnmate/raw/<input_id>.txt` */
export function rawFilePath(paths: VaultPaths, inputId: string): string {
  assertUlid(inputId, 'input_id');
  return join(paths.rawDir, `${inputId}.txt`);
}

/** `vault/.learnmate/draft/<input_id>.json` */
export function draftFilePath(paths: VaultPaths, inputId: string): string {
  assertUlid(inputId, 'input_id');
  return join(paths.draftDir, `${inputId}.json`);
}

/** `vault/.learnmate/resolutions/<input_id>.json`（契约第 12 节） */
export function resolutionFilePath(paths: VaultPaths, inputId: string): string {
  assertUlid(inputId, 'input_id');
  return join(paths.resolutionsDir, `${inputId}.json`);
}

/** `vault/notes/<slug>-<id8>.md` */
export function noteFilePath(paths: VaultPaths, title: string, noteId: string): string {
  assertUlid(noteId, '笔记 id');
  return join(paths.notesDir, noteFileName(title, noteId));
}

/** `vault/.learnmate/trash/<文件名>` */
export function trashFilePath(paths: VaultPaths, fileName: string): string {
  // 只收文件名，不收路径：传 `../x` 进来会被 basename 削成 `x`。
  return join(paths.trashDir, basename(fileName));
}

/**
 * 把一个笔记文件搬进 `trash/`（回收站），返回搬过去之后的**绝对路径**。
 *
 * `--reanalyze` 换掉自己造出来的那批旧笔记时用它（契约第 12.6 节）。三件事值得说明：
 *
 * 1. **搬，不删。** `trash/` 在契约里就是回收站（第 2 节），删错了还能捞回来。
 * 2. **撞名加后缀。** `trash/<原文件名>` 已经存在时改成 `trash/<base>.<n>.md`，
 *    `n` 取最小可用正整数。重跑一次 `--reanalyze` 不该把上一次搬进去的那份盖掉
 *    ——那正是用户唯一还能捞回旧内容的地方。
 * 3. **它不碰台账。** 旧 `ok` 行会在下一次 `rebuild-index` 时按契约 §9.1
 *    「`ok` 行 + 文件不在 → 剔除」自己消失，不需要在这里动手。
 */
export function moveNoteToTrash(paths: VaultPaths, fileName: string): string {
  const source = join(paths.notesDir, basename(fileName));
  if (!existsSync(source)) {
    throw new Error(`搬不了：知识库里没有这个笔记文件：${source}`);
  }

  let target = trashFilePath(paths, fileName);
  if (existsSync(target)) {
    const name = basename(fileName);
    const dot = name.toLowerCase().endsWith('.md') ? name.length - 3 : name.length;
    const stem = name.slice(0, dot);
    const extension = name.slice(dot);
    let counter = 1;
    while (existsSync(target)) {
      target = trashFilePath(paths, `${stem}.${String(counter)}${extension}`);
      counter += 1;
      if (counter > 10_000) {
        throw new Error(`搬不了：trash/ 里已经有太多同名文件了：${name}`);
      }
    }
  }

  try {
    mkdirSync(paths.trashDir, { recursive: true });
    renameSync(source, target);
  } catch (error) {
    throw new Error(`搬不了文件：${source}\n  ${describeCause(error)}`, { cause: error });
  }

  return target;
}

/**
 * 原子写：先写同目录下的临时文件，再改名覆盖。
 *
 * 契约第 6.4 节，第 1–3 步的每一次写入都必须走这里。**禁止就地追加或截断写**
 * ——半写的文件比没有文件更糟：它读起来像个正常文件，但内容是残的，
 * 而且没有任何东西会告诉你它残了。
 *
 * 改名必须和目标文件在同一个目录（同一卷）才是原子的，所以临时文件不放进
 * 系统的临时目录，就放在旁边。
 */
export function writeTextAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // 临时文件名带上 pid 和时间戳：万一上次崩溃留下了一个同名残留，
  // 这次也不会撞上它。它自己会在下面的改名里被覆盖掉或清掉。
  const tempName = `.${basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const tempPath = join(dir, tempName);

  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 临时文件清不掉就算了——绝不能让它盖住真正要报的那个错误。
    }
    throw new Error(`写不了文件：${filePath}\n  ${describeCause(error)}`, { cause: error });
  }
}

/** 读一个文本文件。读不到就抛错（**不返回空字符串**：空文件和读不到是两件事）。 */
export function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`读不了文件：${filePath}\n  ${describeCause(error)}`, { cause: error });
  }
}

/** 文件是否存在。用得很多，所以不让调用方自己去 import `node:fs`。 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * 往文件末尾追加文本，不存在的文件会被创建。
 *
 * **这是唯一一个非原子的写操作，只为台账存在。** 契约第 6.4 节要求第 1–3 步
 * （原文、草稿、笔记）一律原子写，但第 4 步的台账是**追加式**的：它记录的是历史，
 * 历史不能被重写。代价是断电可能留下半行 JSON——契约第 9 节正是为此规定了
 * 「读取时跳过无法解析的行，不得崩溃」。
 *
 * 所以：**不要拿这个函数写 raw/draft/notes。**
 */
export function appendText(filePath: string, content: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, content, 'utf8');
  } catch (error) {
    throw new Error(`写不了文件：${filePath}\n  ${describeCause(error)}`, { cause: error });
  }
}

/**
 * 列出 `notes/` 下的全部笔记文件，返回**绝对路径**，按文件名排序。
 *
 * 排序是刻意的：`rebuild-index` 的输出必须与扫描顺序无关，否则同一个知识库跑两次
 * 会得到两个「不一样」的台账，diff 起来全是噪音。
 */
export function listNoteFiles(paths: VaultPaths): string[] {
  return listFilesIn(paths.notesDir, '.md');
}

/** 列出 `raw/` 下的全部原文（`<input_id>.txt`）。`doctor` 的体检用它找孤儿。 */
export function listRawFiles(paths: VaultPaths): string[] {
  return listFilesIn(paths.rawDir, '.txt');
}

/**
 * 列出 `draft/` 下的全部草稿（`<input_id>.json`）。
 *
 * 它**不会**把裁定文件当成草稿——那些在 `resolutions/` 里。两个目录分开正是为了
 * 这件事：都放在 `draft/` 的话，这个函数按扩展名过滤会把 `xxx.resolutions.json`
 * 也列进来。
 */
export function listDraftFiles(paths: VaultPaths): string[] {
  return listFilesIn(paths.draftDir, '.json');
}

/** 列出 `resolutions/` 下的全部裁定文件（`<input_id>.json`）。 */
export function listResolutionFiles(paths: VaultPaths): string[] {
  return listFilesIn(paths.resolutionsDir, '.json');
}

/** 列出 `quarantine/` 下的全部现场（`<input_id>.json`）。 */
export function listQuarantineFiles(paths: VaultPaths): string[] {
  return listFilesIn(paths.quarantineDir, '.json');
}

/**
 * 列出一个目录下的文件，返回**绝对路径**，按文件名排序。
 *
 * 目录不存在时返回空数组而不是抛错：知识库里没有 `quarantine/` 是**正常状态**
 * （一个现场都没有），不是错误。排序的理由同上——让输出与文件系统的返回顺序无关。
 */
function listFilesIn(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读不了目录：${dir}\n  ${describeCause(error)}`, { cause: error });
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => join(dir, name));
}

/**
 * 把绝对路径转成**相对知识库根、用正斜杠**的路径，例如 `notes/示例笔记-01j8zq7v.md`。
 *
 * 台账里存的就是这个形式。为什么不存绝对路径：搬一次知识库目录（换个盘、放进
 * OneDrive）就会让所有历史记录指向不存在的地方，而相对路径不会；另外它也不把
 * 用户名和目录结构写进每个文件。
 */
export function vaultRelativePath(paths: VaultPaths, filePath: string): string {
  return relative(paths.root, filePath).split(sep).join('/');
}

// ————————————————————— 第 1–3 步写入的具名入口 —————————————————————
// 下面几个是给 pipeline 用的，把「写哪个文件、写什么格式」固定在这里，
// 免得 pipeline 自己去拼路径或者忘记加末尾换行。

/**
 * 第 1 步：把规范化原文写进 `raw/`。**全流程唯一不可跳过的写操作。**
 * 返回写好的路径，方便调用方记账和打印。
 */
export function writeRaw(paths: VaultPaths, inputId: string, normalizedText: string): string {
  const filePath = rawFilePath(paths, inputId);
  writeTextAtomic(filePath, normalizedText);
  return filePath;
}

/** 第 1 步的反向操作：读回原文。 */
export function readRaw(paths: VaultPaths, inputId: string): string {
  return readText(rawFilePath(paths, inputId));
}

/**
 * 第 2 步：把模型这次返回的全部草稿写进 `draft/`。
 *
 * 参数是 `unknown` 而不是具体类型，是因为写进来的应当是**模型的原始产出**——
 * 哪怕它没通过校验，也要原样留着（这样才能事后查是模型胡说还是代码有 bug）。
 * 所以这里不做任何类型检查，只负责序列化。
 */
export function writeDraft(paths: VaultPaths, inputId: string, drafts: unknown): string {
  const filePath = draftFilePath(paths, inputId);
  writeTextAtomic(filePath, `${JSON.stringify(drafts, null, 2)}\n`);
  return filePath;
}

/** 第 2 步的反向操作：读回草稿的原始 JSON 文本。 */
export function readDraft(paths: VaultPaths, inputId: string): string {
  return readText(draftFilePath(paths, inputId));
}

/**
 * 把用户对存疑项的裁定写进 `resolutions/<input_id>.json`（契约第 12.4 节）。
 *
 * 与 `writeDraft` 一样收 `unknown`：这里只管序列化，「这份裁定合不合法」是
 * `core/resolutions.ts` 的事（那边是纯函数，好测）。
 */
export function writeResolutions(paths: VaultPaths, inputId: string, payload: unknown): string {
  const filePath = resolutionFilePath(paths, inputId);
  writeTextAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

/**
 * 读回裁定文件的 JSON 文本。
 *
 * 读不到就抛（和 `readText` 一样）——**「文件不存在」与「文件读得出来但内容不合法」
 * 是两件事**，调用方要分别处理：前者是「用户没改过任何存疑项」，后者要打警告。
 */
export function readResolutions(paths: VaultPaths, inputId: string): string {
  return readText(resolutionFilePath(paths, inputId));
}

/**
 * 校验失败的现场：`quarantine/<input_id>.json`（契约第 7 节，退出码 3）。
 *
 * 存的是**模型的原始产出**——每一次尝试的原文都留着，而不是最后那一次的。
 * 排查「模型为什么老是不按格式回」的时候，第一次和第三次的差别往往就是全部线索。
 *
 * 与 `writeDraft` 一样收 `unknown`：这里要的正是「原样」，绝不能在中途做类型检查
 * 或者整理格式——那会把证据变成猜测。
 */
export function quarantineFilePath(paths: VaultPaths, inputId: string): string {
  assertUlid(inputId, 'input_id');
  return join(paths.quarantineDir, `${inputId}.json`);
}

/** 把现场写进 `quarantine/`，返回写好的路径。 */
export function writeQuarantine(paths: VaultPaths, inputId: string, payload: unknown): string {
  const filePath = quarantineFilePath(paths, inputId);
  writeTextAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

/**
 * 第 3 步：把渲染好的 Markdown 写进 `notes/`，文件名由标题和笔记 id 决定。
 * 返回写好的路径。
 */
export function writeNote(
  paths: VaultPaths,
  title: string,
  noteId: string,
  markdown: string,
): string {
  const filePath = noteFilePath(paths, title, noteId);
  writeTextAtomic(filePath, markdown);
  return filePath;
}

// ————————————————————————————— 内部实现 —————————————————————————————

/**
 * 拼路径前先确认这是个 ULID。
 *
 * 这个检查看着多余（id 是我们自己生成的），但它挡住的是最坏的一类 bug：
 * 一旦有 `../` 混进来，写的就不是知识库而是别的地方了，而且表面上一切正常。
 * 在一个「原文永不丢失」是最高优先级的项目里，这种保险值得。
 */
function assertUlid(id: string, what: string): void {
  if (!ULID_PATTERN.test(id)) {
    throw new UsageError(
      `${what} 不是合法的 ULID：${JSON.stringify(id)}\n` +
        `  应该是 26 个大写字母或数字（不含 I / L / O / U）。`,
    );
  }
}

/** 取异常的简短描述。不用 core 的 `describeError`，避免 io 反向依赖 core 的消息格式。 */
function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
