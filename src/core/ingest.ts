import { fingerprint } from '../util/hash.js';
import { UsageError } from './errors.js';

/**
 * ingest：把「用户贴进来的那段文字」变成一份确定的、可以拿去哈希和落盘的规范化文本。
 *
 * 契约见 docs/03-contracts.md 第 5.5 节。
 *
 * 这一层是**纯函数**：不读文件、不联网、不看时钟、不取随机数。
 * 同样的输入永远得到一模一样的输出——否则指纹就失去意义了。
 * （它不生成 `input_id`：那需要时间与随机数，由 pipeline 用 `util/id.ts` 生成后另行配对。）
 */

/** 开头的 UTF-8 BOM。记事本「另存为 UTF-8」会悄悄加上它。 */
const BOM = '\uFEFF';

/** 零宽字符：从网页或聊天窗口复制粘贴时最爱混进来的隐形垃圾。契约只点名了这三个加 BOM。 */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/gu;

export interface IngestOptions {
  /** 规范化之后允许的最大字符数。来自配置的 `maxInputChars`。超过直接报错，**绝不截断**。 */
  maxInputChars: number;
  /** 输入来源的展示名（例如文件名），只用于让报错信息说得清是哪份输入。 */
  sourceLabel?: string;
}

export interface IngestResult {
  /** 规范化文本。哈希、送模型、落盘到 `raw/` 用的都是它。 */
  normalized: string;
  /** `sha256:<64 位小写十六进制>`。 */
  hash: string;
  /** 规范化文本的字符数，**按 Unicode 码点算，末尾那个换行不算**（见 countInputCharacters）。 */
  charCount: number;
}

/**
 * 规范化。规则严格按契约第 5.5 节的顺序执行，顺序本身是有意义的。
 */
export function normalizeText(raw: string): string {
  let text = raw;

  // 1. 去掉开头的 BOM。
  if (text.startsWith(BOM)) text = text.slice(1);

  // 2. 统一换行：Windows 的 CRLF 和老式 Mac 的裸 CR 都变成 LF。
  //    没有这一步，「同一段文字」在两种编辑器里存出来就是两个不同的指纹。
  text = text.replace(/\r\n?/g, '\n');

  // 3. 去掉零宽字符。
  text = text.replace(ZERO_WIDTH, '');

  // 4. 去掉每行行尾的空白。粘贴来的文字经常带一串看不见的空格。
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n');

  // 5. 连续 3 个及以上换行折叠为 2 个（正文里最多保留一个空行）。
  text = text.replace(/\n{3,}/gu, '\n\n');

  // 6. 去掉整体首尾空白，末尾恰好补一个换行。
  return `${text.trim()}\n`;
}

/**
 * 数「用户实际写了多少个字」：按 Unicode 码点算（一个汉字、一个 emoji 都算 1），
 * 末尾那个换行是规范化补上去的，不算。
 *
 * 不这么做的话，用户把 maxInputChars 设成 20000、贴了正好 20000 个字，却被告知超了 1 个。
 */
function countInputCharacters(normalized: string): number {
  const codePoints = [...normalized].length;
  return normalized.endsWith('\n') ? codePoints - 1 : codePoints;
}

/**
 * 规范化 + 算指纹 + 长度守卫。
 *
 * 超过长度上限时抛 `UsageError`（退出码 2）。**绝不截断**：被截断的输入会产出一条
 * 看起来完全正常、但少了后半段的笔记，用户很可能一直发现不了。
 */
export function ingest(raw: string, options: IngestOptions): IngestResult {
  const normalized = normalizeText(raw);
  const charCount = countInputCharacters(normalized);

  if (charCount > options.maxInputChars) {
    const where =
      options.sourceLabel === undefined ? '' : `来源：${options.sourceLabel}\n`;
    throw new UsageError(
      `${where}这段文字有 ${charCount} 个字符，超过了上限 ${options.maxInputChars}。\n` +
        `LearnMate 不会截断你的输入——截断会把一条笔记悄悄变成半条，你多半发现不了。\n` +
        `请拆成几次输入，或者调大 learnmate.config.json 里的 maxInputChars。`,
    );
  }

  return { normalized, hash: fingerprint(normalized), charCount };
}
