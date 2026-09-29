/**
 * 提示词组装（契约第 4.7 节）。
 *
 * 纯函数：给一个模板字符串和一份标签词表，拼出要发给模型的**系统消息**。
 *
 * 它**不读文件**——读文件是 `src/io/prompt.ts` 的事。这样分开有两个原因：
 *   1. 「文件读不到」（路径写错、promptVersion 拼错）和「模板写坏了」（占位符丢了、
 *      多了个 `{{}}`）是两类完全不同的错误，用户要采取的行动也不同；
 *   2. 组装逻辑只有这样才测得动。
 *
 * 这里**不用模板引擎**。`split().join()` 就够了，而且模板引擎的 if/for 会让同一份
 * 提示词文件在不同输入下走不同分支——那样 `prompt_version` 这个字段就无法描述
 * 「模型到底看到了什么」，frontmatter 里那行记录也就失去意义了。
 */

import { UsageError } from './errors.js';

/** 提示词文件里唯一被允许出现的占位符。必须恰好出现一次。 */
export const TAG_VOCABULARY_PLACEHOLDER = '{{TAG_VOCABULARY}}';

/** 一个标签都没有时替换成什么。契约 4.7：**绝不留下裸露的占位符**。 */
export const EMPTY_VOCABULARY = '（还没有任何标签。这是第一批笔记，你可以自由新建。）';

/**
 * 词表最多列出多少个标签。
 *
 * 这不是「标签上限」，只是提示词长度的一道保险——标签是累积的，几千条笔记之后
 * 全量列出来会白占上下文。超出时**明确写出还有多少个没列**，不静默截断。
 * （标签同义词膨胀本身是另一个待解决问题，还债时机是标签数超过 200 条。）
 */
const MAX_VOCABULARY_TAGS = 200;

/** 一个**格式完好**的 `{{...}}` 记号。 */
const BRACE_TOKEN = /\{\{[^{}]*\}\}/g;

/** 去掉了所有完好记号之后，还剩这种双括号就说明有东西写坏了。 */
const DANGLING_BRACE = /\{\{|\}\}/;

/**
 * 去重、`trim`、丢掉空项，然后按 UTF-16 码元升序排序。
 *
 * 导出是给 `tags` 命令用的：用户从 `tags` 看到的清单必须与提示词里注入的那份
 * **是同一个集合、同一个顺序**，否则他会对着自己的笔记核对却对不上，而且没有任何东西
 * 会告诉他这两份本来就不该不同。**去重与排序只在这一处定义。**
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const unique = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))];
  // 默认排序按 UTF-16 码元比较，不依赖语言环境，所以跨机器结果一致。
  unique.sort();
  return unique;
}

/**
 * 把标签列表渲染成词表文本。一行一个，前面加 `- `。
 *
 * 会**去重并排序**。排序不是为了好看：同样的标签集必须永远得到逐字符相同的提示词，
 * 否则「同一份知识库 + 同一套配置」会产出不同请求，供应商那边的提示词缓存全部落空。
 */
export function renderTagVocabulary(tags: readonly string[]): string {
  const unique = normalizeTags(tags);
  if (unique.length === 0) return EMPTY_VOCABULARY;

  const shown = unique.slice(0, MAX_VOCABULARY_TAGS);
  const lines = shown.map((tag) => `- ${tag}`);
  if (unique.length > shown.length) {
    lines.push(`（词表里还有 ${unique.length - shown.length} 个标签没列出来。）`);
  }
  return lines.join('\n');
}

/**
 * 检查提示词模板是不是能被安全地组装。
 *
 * 不合格就**抛错拒绝**，绝不把半成品发给模型。理由是契约 4.7 里那句：
 * 模型收到一个看不懂的记号**不会报错**，它会猜或者直接忽略，然后泰然自若地吐出一份
 * 看起来正常、但标签一个都没复用词表的结果。一个笔误就这样静默地变成了提示词的一部分。
 */
export function assertPromptTemplate(template: string): void {
  const problems: string[] = [];

  if (template.trim() === '') {
    problems.push('文件是空的');
  }

  const occurrences = template.split(TAG_VOCABULARY_PLACEHOLDER).length - 1;
  if (occurrences === 0) {
    problems.push(`找不到占位符 ${TAG_VOCABULARY_PLACEHOLDER}`);
  } else if (occurrences > 1) {
    problems.push(`${TAG_VOCABULARY_PLACEHOLDER} 出现了 ${occurrences} 次，必须恰好 1 次`);
  }

  // 认得的记号之外，任何 `{{...}}` 都是错的——哪怕它「看起来像」一个占位符。
  // 契约 4.7：模型收到看不懂的记号**不会报错**，它会猜或者直接忽略。
  const unknown = (template.match(BRACE_TOKEN) ?? []).filter(
    (token) => token !== TAG_VOCABULARY_PLACEHOLDER,
  );
  if (unknown.length > 0) {
    problems.push(
      `出现了不认识的占位符 ${unknown.join('、')}。` +
        `这个项目只认 ${TAG_VOCABULARY_PLACEHOLDER} 一个。`,
    );
  }

  // 再摘掉所有格式完好的 `{{...}}`，找剩下的残骸：`{{` 少了右括号、或者凭空一个 `}}`。
  const stripped = template.replace(BRACE_TOKEN, '');
  const dangling = DANGLING_BRACE.exec(stripped);
  if (dangling !== null) {
    const line = lineAt(stripped, dangling.index);
    problems.push(
      `第 ${line.number} 行有不成对的 ${JSON.stringify(dangling[0])}：${line.text}\n` +
        `    提示：写成 {{名字}} 才算一个占位符，而这个项目只认 ${TAG_VOCABULARY_PLACEHOLDER} 一个。`,
    );
  }

  if (problems.length > 0) {
    throw new UsageError(
      `提示词文件用不了，有 ${problems.length} 处问题：\n` +
        problems.map((problem) => `  · ${problem}`).join('\n') +
        `\n\n提示词文件的规矩见 docs/03-contracts.md 第 4.7 节。`,
    );
  }
}

/**
 * 把模板里的占位符换成真实词表，得到要发给模型的系统消息。
 * 模板有问题时抛 `UsageError`（退出码 2），**不会**产生任何写入或网络请求。
 */
export function assembleSystemMessage(template: string, tags: readonly string[]): string {
  assertPromptTemplate(template);
  return template.split(TAG_VOCABULARY_PLACEHOLDER).join(renderTagVocabulary(tags));
}

/** 取第 `index` 个字符所在的行号与该行内容，用于把「哪一行坏了」说清楚。 */
function lineAt(text: string, index: number): { number: number; text: string } {
  const before = text.slice(0, index);
  const number = before.split('\n').length;
  const lineText = text.split('\n')[number - 1] ?? '';
  return { number, text: lineText.trim() };
}
