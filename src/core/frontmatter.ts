/**
 * 从磁盘上的笔记文件里读回 frontmatter。
 *
 * 这是 `render` 的逆运算，但**故意不是一个通用的 YAML 解析器**。它只认 `render` 写出来的
 * 那个子集：一行一个 `key: value`，值要么是裸标量、要么是双引号包起来的字符串，
 * 列表写成缩进两格的 `- 项`。
 *
 * 为什么这么克制：
 * 1. 引第三方 YAML 库会给 v0.1 增加一个依赖，而它要解决的问题我们并不真的面对——
 *    frontmatter 是我们自己写的，格式是已知的；
 * 2. 通用解析器会把「这个文件根本不是我们写的」也当成合法输入，于是垃圾数据一路
 *    流到后面才炸。这里宁可**明确地看不懂**，然后被调用方计数跳过；
 * 3. `rebuild-index` 的全部价值就在于「不信任台账、只信任笔记文件」，而它必须
 *    面对手工改坏、被别的工具重排过的文件。一个会说「第 7 行不是 key: value」的
 *    解析器，比一个默默返回半个对象的解析器有用得多。
 *
 * 纯函数：不读文件、不看时钟。
 */

import type { NoteFrontmatter } from './contracts.js';

/** 解析结果。看不懂就返回失败**并说明原因**，绝不返回半个对象。 */
export type FrontmatterParse =
  | { ok: true; frontmatter: NoteFrontmatter }
  | { ok: false; reason: string };

const DELIMITER = '---';

/** 必须出现的字段。缺任何一个都算这个文件不是 LearnMate 写的。 */
const REQUIRED_STRING_FIELDS = [
  'id',
  'title',
  'created',
  'updated',
  'summary',
  'status',
  'source_hash',
  'language',
  'model',
  'prompt_version',
] as const;

function fail(reason: string): FrontmatterParse {
  return { ok: false, reason };
}

/**
 * 去掉 `render` 加上的双引号。
 *
 * 转义规则必须与 `render` 的 `yamlScalar` **严格互逆**：它只产生 `\\` 和 `\"`，
 * 这里就只还原这两个。多还原别的（比如把 `\n` 变成真换行）会让解析结果与写出去的内容
 * 不再一致——那正是「静默改数据」。
 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return value;
}

/** 把 `---` 之间的行读成一张表：值要么是字符串，要么是字符串数组（列表字段）。 */
function readFields(lines: string[], from: number, to: number): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let listKey: string | null = null;
  let listLine = 0;

  for (let i = from; i < to; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;

    const item = /^\s+-\s?(.*)$/.exec(line);
    if (item !== null && listKey !== null) {
      const current = fields.get(listKey);
      if (Array.isArray(current)) current.push(unquote(item[1] ?? ''));
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new Error(`第 ${i + 1} 行不是「键: 值」的形式：${JSON.stringify(line)}`);
    }

    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1);
    listKey = null;

    if (rawValue.trim() === '') {
      // `tags:` 后面跟着一串缩进项。
      fields.set(key, []);
      listKey = key;
      listLine = i + 1;
    } else {
      fields.set(key, unquote(rawValue));
    }
  }

  // 声明了是列表、却一项都没有的，当作空列表——但那通常是写坏了，留给上层判断。
  void listLine;
  return fields;
}

function readString(fields: Map<string, string | string[]>, key: string): string | null {
  const value = fields.get(key);
  return typeof value === 'string' ? value : null;
}

/**
 * 解析一条笔记文件的 frontmatter。
 *
 * 输入是整篇 Markdown。找不到 frontmatter、缺必填字段、类型不对，一律返回失败原因。
 */
export function parseFrontmatter(markdown: string): FrontmatterParse {
  // 契约规定换行统一 LF，但容忍 CRLF —— 用户可能用别的编辑器顺手存过。
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  if ((lines[0] ?? '').trim() !== DELIMITER) {
    return fail('文件不是以 --- 开头，没有 frontmatter');
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === DELIMITER) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return fail('只有开头的 ---，找不到结束的 ---');
  }

  let fields: Map<string, string | string[]>;
  try {
    fields = readFields(lines, 1, end);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const missing = REQUIRED_STRING_FIELDS.filter((key) => readString(fields, key) === null);
  if (missing.length > 0) {
    return fail(`缺少必填字段：${missing.join('、')}`);
  }

  const tags = fields.get('tags');
  if (!Array.isArray(tags)) {
    return fail('tags 不是一个列表');
  }

  const schemaVersionRaw = readString(fields, 'schema_version');
  const schemaVersion = Number(schemaVersionRaw);
  if (schemaVersionRaw === null || !Number.isInteger(schemaVersion)) {
    return fail(`schema_version 不是整数：${JSON.stringify(schemaVersionRaw)}`);
  }

  const sourceRef = readString(fields, 'source_ref');
  const inputId = readString(fields, 'input_id');

  const frontmatter: NoteFrontmatter = {
    id: readString(fields, 'id') ?? '',
    title: readString(fields, 'title') ?? '',
    created: readString(fields, 'created') ?? '',
    updated: readString(fields, 'updated') ?? '',
    summary: readString(fields, 'summary') ?? '',
    tags,
    status: readString(fields, 'status') ?? '',
    source_hash: readString(fields, 'source_hash') ?? '',
    schema_version: schemaVersion,
    language: readString(fields, 'language') ?? '',
    model: readString(fields, 'model') ?? '',
    prompt_version: readString(fields, 'prompt_version') ?? '',
  };
  if (inputId !== null) frontmatter.input_id = inputId;
  if (sourceRef !== null) frontmatter.source_ref = sourceRef;

  return { ok: true, frontmatter };
}

/**
 * 取出 frontmatter 之后的**正文**（`show` 默认要打的那部分）。
 *
 * 与 `parseFrontmatter` 分开，是因为两者的失败语义不同：解析失败意味着「这篇读不懂」，
 * 而取正文失败（没有 frontmatter、或只有开头的 `---`）**不代表没有正文可看**——
 * 那种文件照样该整篇打给用户，由调用方决定怎么处理。所以这里返回 `null` 而不抛错。
 *
 * 正文是**原样切片**，不重新排版：`show` 的输出要能被 `>` 重定向存回一个 Markdown 文件，
 * 中途做任何格式化都是在改用户的笔记。只去掉分隔用的那行空行——它是 `render` 的版式，
 * 不是内容。
 */
export function noteBody(markdown: string): string | null {
  const lines = markdown.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '').trim() !== DELIMITER) return null;

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').replace(/\r$/, '').trim() === DELIMITER) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  return lines
    .slice(end + 1)
    .join('\n')
    .replace(/^(?:\r?\n)+/, '');
}
