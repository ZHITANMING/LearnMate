/**
 * `learnmate tags` —— 知识库里用过哪些标签。
 *
 * 这个命令看着简单，但它存在的意义是**让用户能核对模型看到的东西**：`add` 会把词表
 * 拼进系统消息，提示词要求模型「优先复用已有标签」（契约 §4.7）。用户凭什么相信
 * 模型看到的词表和磁盘上的笔记一致？就凭这个命令能把它原样打出来。
 *
 * 所以取词**必须**与 `add` 调用同一个 `collectKnownTags`，排序去重**必须**
 * 与 `renderTagVocabulary` 调用同一个 `normalizeTags`。不许自己遍历一遍目录、
 * 也不许去解析别的命令的输出——那样两份清单会分头演化，而没有任何东西会告诉用户
 * 它们不一致。
 *
 * 只读、零写入、不调模型、不需要 API Key。
 */

import { loadConfig } from '../config.js';
import type { AppConfig } from '../config.js';
import type { NoteSummary } from '../core/contracts.js';
import { EXIT } from '../core/errors.js';
import type { ExitCode } from '../core/errors.js';
import { normalizeTags } from '../core/prompt.js';
import { collectKnownTags, readNoteSummaries } from '../io/notes.js';
import { vaultPaths } from '../io/vault.js';

/** 一个标签都没有时打这一行。措辞与契约 §4.7 保持一致。 */
export const EMPTY_TAGS_MESSAGE = '（还没有任何标签。）\n';

export interface RunTagsCommandOptions {
  /** 每个标签后面跟一个制表符和它被几篇笔记用过。 */
  counts?: boolean;
  /** 配置文件的基目录，默认 `process.cwd()`。测试时传临时目录进来。 */
  baseDir?: string;
}

/**
 * 数每个标签被**几篇笔记**用过。
 *
 * 一篇里同一个标签写了两遍只算一次（Set 语义）——用户想看的是「多少个标签、
 * 各覆盖多少笔记」，不是「这个词出现过几次」。
 */
export function countTags(summaries: readonly NoteSummary[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const summary of summaries) {
    const frontmatter = summary.frontmatter;
    if (frontmatter === null) continue; // 读不懂的笔记不参与计数，也不该让命令失败

    const seen = new Set<string>();
    for (const tag of frontmatter.tags) {
      const trimmed = tag.trim();
      if (trimmed === '' || seen.has(trimmed)) continue;
      seen.add(trimmed);
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * 渲染成最终要打出去的那段字。**纯函数**：一行一个标签，没有前缀、没有 `#`、
 * 没有颜色——它的输出要能被 `>` 存成一个文件直接当词表用。
 *
 * 带 `counts` 时在标签后面追加 `\tN`，**不改变行的顺序**。
 */
export function renderTagList(
  tags: readonly string[],
  counts?: ReadonlyMap<string, number>,
): string {
  if (tags.length === 0) return EMPTY_TAGS_MESSAGE;

  const lines = tags.map((tag) =>
    counts === undefined ? tag : `${tag}\t${counts.get(tag) ?? 0}`,
  );
  return `${lines.join('\n')}\n`;
}

export function runTagsCommand(options: RunTagsCommandOptions = {}): ExitCode {
  const config: AppConfig = loadConfig({ baseDir: options.baseDir });

  // 只算路径，不建目录：`tags` 是只读命令。
  const paths = vaultPaths(config.vaultPath);

  // 取词走 `add` 用的那个函数，顺序与提示词里的词表一致。
  const tags = normalizeTags(collectKnownTags(paths));

  // `--counts` 时才多读一遍。默认路径只做一次取词，与 `add` 的开销一样。
  const counts = options.counts === true ? countTags(readNoteSummaries(paths)) : undefined;

  process.stdout.write(renderTagList(tags, counts));
  return EXIT.OK;
}
