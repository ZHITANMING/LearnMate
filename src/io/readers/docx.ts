/**
 * `.docx` → 纯文本（v0.2「多格式输入」的第一个读取器）。
 *
 * 契约见 docs/03-contracts.md 第 5.6 节。抽取发生在**任何写入之前**：抽出来的文字
 * 接着走与纯文本输入**完全相同**的规范化（5.5）、指纹（5.4）与落盘路径——`ingest`
 * 和它后面的一切都只看见文本，不知道来源是什么格式。
 *
 * **为什么自己解 ZIP 而不用库：** `.docx` 就是一个 ZIP 包着 `word/document.xml`，
 * 而 Node 自带 `node:zlib`。整个读取器只做两件事——从中央目录里找到那个条目、把 XML
 * 里的文字抠出来——为此拉一个压缩库进来不划算（本项目的运行时依赖只有 commander）。
 *
 * **已知天花板**（有意接受，见 decisions.md D42）：
 *   - 不支持 ZIP64、加密包、分卷压缩；
 *   - 只认 `word/document.xml`：页眉、页脚、批注、脚注、文本框以外的浮动内容都不会出现；
 *   - 只认 `<w:t>`：域代码、修订删除的文字（`<w:delText>`）都不是正文，不会出现；
 *   - 表格拍平成「一行的单元格用 Tab 分隔」，合并单元格的文字会重复出现；
 *   - 图片、图表、公式（OMML）里的内容抽不出来——通篇只有这些的 docx 会被判成「没有文字」。
 */

import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { UsageError } from '../../core/errors.js';

/** 只看扩展名，不看内容。改名成 `.docx` 的别的东西会在解 ZIP 时报错。 */
export function isDocxFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.docx');
}

/**
 * 抽出一份 `.docx` 的正文。
 *
 * 失败一律抛 `UsageError`（退出码 2）：此时 `raw/` 都还没写，符合「用法错误零写入」的承诺。
 * 用户能自己修的问题（文件损坏、不是 Word 文档、通篇图片）不该被报成「未预期错误」。
 */
export function docxToText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = documentXmlToText(extractEntry(bytes, DOCUMENT_ENTRY));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `这份 .docx 读不出来：${error instanceof Error ? error.message : String(error)}\n` +
        '  可能是文件损坏了，或者它根本不是 Word 文档。',
      { cause: error },
    );
  }

  if (text.trim() === '') {
    throw new UsageError(
      '这份 .docx 里一个字都没抽出来。\n' +
        '  常见原因：它是扫描件或纯图片拼的（Word 文档里没有文字，只有图片）。\n' +
        '  这种情况需要先做 OCR，LearnMate 目前还不会——可以把文字复制出来再当成文本输入。',
    );
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * ZIP：从中央目录里取一个条目
 * ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50; // 「中央目录结束」记录，在文件末尾
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22; // 无注释时它正好这么长
const MAX_COMMENT = 0xffff; // 注释最长 64 KiB，所以 EOCD 一定落在末尾这一段里
const DOCUMENT_ENTRY = 'word/document.xml';
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** 把 `wanted` 这个条目解出来，按 UTF-8 变成字符串。 */
function extractEntry(zip: Uint8Array, wanted: string): string {
  // 全程用 DataView 读：它越界就抛，不会像数组下标那样悄悄给出 undefined
  // （本项目开了 noUncheckedIndexedAccess，这个选择顺便省掉一堆 `?? 0`）。
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const total = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  for (let index = 0; index < total; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) break; // 中央目录到头了
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));

    if (name === wanted) {
      return new TextDecoder().decode(readLocalEntry(view, zip, localOffset, method, compressedSize));
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  throw new UsageError(
    `这份 .docx 里找不到 ${wanted}——它不像是一份 Word 文档（.docx）。\n` +
      '  老的 .doc 格式不是压缩包，LearnMate 不支持；请在 Word 里另存为 .docx。',
  );
}

/**
 * 从文件末尾往前找「中央目录结束」记录。
 *
 * 必须从后往前找：注释里也可能出现同样的四个字节，而真正的 EOCD 在最后。
 */
function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = view.byteLength - EOCD_MIN_SIZE; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new UsageError(
    '这不是一个压缩包，所以它不是 .docx 文件。\n' +
      '  如果它本来是 .doc（老格式），请在 Word 里打开、另存为 .docx 再试——\n' +
      '  改个扩展名是不管用的，两种格式内部完全不同。\n' +
      '  如果它本该是 .docx，那可能是保存中断，文件坏了。',
  );
}

/** 读本地头，跳过文件名与扩展区，拿到这一段压缩数据。 */
function readLocalEntry(
  view: DataView,
  zip: Uint8Array,
  offset: number,
  method: number,
  compressedSize: number,
): Uint8Array {
  if (view.getUint32(offset, true) !== LOCAL_SIGNATURE) {
    throw new UsageError('这份 .docx 的内部索引对不上，文件可能损坏了。');
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const raw = zip.subarray(start, start + compressedSize);

  if (method === METHOD_STORED) return raw;
  if (method === METHOD_DEFLATE) return inflateRawSync(raw);
  throw new UsageError(`这份 .docx 用了不认识的压缩方式（${String(method)}），读不了。`);
}

/* ------------------------------------------------------------------ *
 * WordprocessingML：把 XML 变成文字
 * ------------------------------------------------------------------ */

/** XML 里那五个预定义实体。别的（如 `&nbsp;`）在 XML 里本就不合法，不处理。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * 抠文字时用的三个哨兵。
 *
 * 它们是 XML 1.0 里**不允许出现的控制字符**，所以正文里绝不会有，可以放心当占位符用。
 */
const MARK_TEXT = '\u0001'; // 这里原本有一个 <w:t>，文字先寄存在别处
const MARK_LINE = '\u0002'; // 一次换行
const MARK_CELL = '\u0003'; // 一次制表（表格里换到下一个单元格）

/**
 * 把 document.xml 里的文字抠出来。
 *
 * 规矩只有一条：**除了 `<w:t>` 里的文字和几个能翻译成空白的结构标记，什么都不留**。
 * 标签、属性、XML 声明、元素之间的换行与缩进，全部丢弃——Word 存文件时把 XML 排版得
 * 好不好看，不该影响抽出来的正文（真实文件在 `<?xml …?>` 后面就有一个换行）。
 *
 * 顺序是有讲究的：
 *   1. 先把 `<w:t>` 的内容**整段取走**换成哨兵。这样后面的结构替换碰不到正文里的字，
 *      也不会把正文里的 `&lt;` 解成一个真的 `<` 再当标签删掉。
 *   2. 把结构翻译成哨兵（段落 → 换行，单元格 → 制表）。
 *   3. **删掉除哨兵以外的一切**。这是「什么都不留」的落实处。
 *   4. 最后才解实体、把文字放回来。域代码（`HYPERLINK`、`PAGE` 之类）和修订删除的
 *      文字（存在 `<w:delText>` 里，不是 `w:t`）都是在这一步之前就没了的。
 */
function documentXmlToText(xml: string): string {
  const texts: string[] = [];
  const marked = xml
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_match: string, text: string): string => {
      texts.push(text);
      return MARK_TEXT;
    })
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<w:tab\b[^>]*\/>/g, MARK_CELL)
    .replace(/<w:br\b[^>]*\/>/g, MARK_LINE)
    // 单元格里的最后一段不再另起一行，否则每个格子的内容都会被拆成两行。
    .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>')
    .replace(/<w:p\b[^>]*\/>/g, MARK_LINE) // 空段落
    .replace(/<\/w:p>/g, MARK_LINE)
    .replace(/<\/w:tc>/g, MARK_CELL)
    .replace(/<\/w:tr>/g, MARK_LINE)
    .replace(/[^\u0001\u0002\u0003]/g, '');

  let next = 0;
  return marked
    .replace(/\u0003+\u0002/g, MARK_LINE) // 一行最后一个格子后面那个多余的制表符
    .replace(/[\u0001\u0002\u0003]/g, (mark: string): string => {
      if (mark === MARK_TEXT) return decodeEntities(texts[next++] ?? '');
      return mark === MARK_LINE ? '\n' : '\t';
    });
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (match: string, decimal?: string, hex?: string, named?: string): string => {
      if (named !== undefined) return NAMED_ENTITIES[named] ?? match;
      const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    },
  );
}
