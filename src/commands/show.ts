/**
 * `learnmate show <关键词>` —— 把一篇笔记打出来。
 *
 * 数据源与 `list` 相同：`notes/` 目录，**不读台账**。
 * 只读、零写入、不调模型、不需要 API Key。
 *
 * 这个命令最要紧的一条是**拿不准就不猜**：关键词命中多篇时打印候选清单并退出码 2，
 * 绝不「取第一个」或者「取最新的」。猜错的代价不是多打一行字，而是用户以为自己看的
 * 是 A、实际是 B，并且没有任何办法察觉——三条笔记的正文都像模像样。
 *
 * 输出分两路：**正文只走 stdout**（这样 `show 示例 > 笔记.md` 存下来的就是笔记），
 * 提示语、候选清单、警告一律走 stderr。
 */

import { basename } from 'node:path';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../config.js';
import type { NoteSummary } from '../core/contracts.js';
import { EXIT } from '../core/errors.js';
import type { ExitCode } from '../core/errors.js';
import { describeError } from '../core/errors.js';
import { noteBody } from '../core/frontmatter.js';
import { readNoteSummaries } from '../io/notes.js';
import { readText, vaultPaths } from '../io/vault.js';
import { compareSummaries, renderNoteLine } from './list.js';

/**
 * 完整 id 的形状。
 *
 * 只用来判断「用户给的是不是一个 id」——命中了就只按 frontmatter 的 `id` 精确匹配，
 * 不再退回去当子串搜：给出 26 位 ULID 的人意图很明确，此时再去模糊匹配只会让人困惑。
 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** 候选清单最多列几条。再多就不如让用户把关键词写长一点。 */
const CANDIDATE_LIMIT = 10;

export interface ShowOptions {
  /** 连 frontmatter 一起打（默认只打正文）。 */
  raw?: boolean;
}

export interface RunShowCommandOptions extends ShowOptions {
  /** 配置文件的基目录，默认 `process.cwd()`。测试时传临时目录进来。 */
  baseDir?: string;
}

/** 文件名去掉 `.md` —— `show` 认这个，也认标题。 */
function fileStem(relativePath: string): string {
  return basename(relativePath).replace(/\.md$/i, '');
}

/**
 * 按关键词筛出候选。**只筛选、不排序**（顺序由调用方决定，与 `list` 一致）。
 *
 * 规则（契约 §11.4）：
 * 1. 关键词是 26 位 ULID 时，只按 `frontmatter.id` 精确匹配（大小写不敏感）；
 * 2. 否则当子串，大小写不敏感，同时匹配**文件名（去 `.md`）**与**标题**；
 * 3. 完全相等优先于子串——`show 示例笔记-先做-A-再做-B-01m3nrxy` 只该命中那一篇，
 *    而不是所有名字里含这两个字的笔记。
 *
 * 读不懂 frontmatter 的笔记仍然可能被文件名命中，这是有意的：坏文件也看得见（§11.2）。
 */
export function selectNotes(summaries: NoteSummary[], query: string): NoteSummary[] {
  const wanted = query.trim();
  if (wanted === '') return [];

  const lowered = wanted.toLowerCase();

  if (ULID_PATTERN.test(wanted)) {
    return summaries.filter(
      (summary) =>
        summary.frontmatter !== null && summary.frontmatter.id.toLowerCase() === lowered,
    );
  }

  const hit = (summary: NoteSummary): { exact: boolean; partial: boolean } => {
    const stem = fileStem(summary.relativePath).toLowerCase();
    const title = summary.frontmatter?.title.toLowerCase();
    const exact = stem === lowered || title === lowered;
    const partial =
      stem.includes(lowered) || (title !== undefined && title.includes(lowered));
    return { exact, partial };
  };

  const matched = summaries.filter((summary) => hit(summary).partial);
  const exact = matched.filter((summary) => hit(summary).exact);

  return exact.length > 0 ? exact : matched;
}

/**
 * 候选清单。每条与 `list` 同一个格式（`renderNoteLine`），并明说「我不猜」。
 */
export function renderCandidates(query: string, matches: NoteSummary[]): string {
  const shown = matches.slice(0, CANDIDATE_LIMIT);
  const lines = [`「${query}」命中了 ${matches.length} 篇，没法确定你要哪一篇：`, ''];
  for (const summary of shown) lines.push(renderNoteLine(summary));

  const rest = matches.length - shown.length;
  if (rest > 0) {
    lines.push('');
    lines.push(`…… 还有 ${rest} 条，把关键词写长一点再试。`);
  }

  return `${lines.join('\n')}\n`;
}

export function runShowCommand(query: string, options: RunShowCommandOptions = {}): ExitCode {
  const config: AppConfig = loadConfig({ baseDir: options.baseDir });

  // 只算路径，不建目录：`show` 是只读命令。
  const paths = vaultPaths(config.vaultPath);
  const summaries = readNoteSummaries(paths);
  const matches = selectNotes(summaries, query);

  if (matches.length === 0) {
    process.stderr.write(
      `没有匹配的笔记。\n` +
        `（库里现在有 ${summaries.length} 篇；跑 node dist/main.js list 看看都有什么，` +
        `或者把关键词换成完整的 26 位 id。）\n`,
    );
    return EXIT.USAGE;
  }

  if (matches.length > 1) {
    process.stderr.write(renderCandidates(query.trim(), [...matches].sort(compareSummaries)));
    return EXIT.USAGE;
  }

  const only = matches[0];
  if (only === undefined) return EXIT.OK; // 到不了这里：上面已经拦过 0 与多篇。

  let text: string;
  try {
    text = readText(only.path);
  } catch (error) {
    // 刚才列得出来、现在读不到：文件在两次读之间被删了或权限变了。这是未预期的状态，
    // 不该伪装成「没有匹配的笔记」。
    throw new Error(
      `笔记文件读不出来：${only.relativePath}\n  ${describeError(error)}`,
      { cause: error },
    );
  }

  if (options.raw === true) {
    process.stdout.write(text);
    return EXIT.OK;
  }

  const body = noteBody(text);
  if (body === null) {
    // 读不懂 frontmatter 就拿不到正文的起点。此时**宁可整篇打出去**也不要什么都不打：
    // 用户要的内容就在这个文件里，只是我们认不出它的边界在哪。
    process.stderr.write(
      `这篇笔记的 frontmatter 读不懂（${only.problem ?? '原因不明'}），` +
        `拿不到正文的起点，下面打出来的是整篇。\n`,
    );
    process.stdout.write(text);
    return EXIT.OK;
  }

  process.stdout.write(body);
  return EXIT.OK;
}
