/**
 * `notes/` 目录：从磁盘上的笔记文件读回来的那一面。
 *
 * 存在的理由是一条设计立场：**笔记文件是真相，台账是派生数据**（契约 §9）。
 * 「我库里有什么」这个问题，答案就在 `notes/` 里，不在 `ledger.jsonl` 里——
 * 后者可以合法地整个删掉再由 `rebuild-index` 长回来，让浏览命令依赖它，
 * 就等于让「知识库有什么」这个事实依赖一个可以被删掉的文件。
 *
 * 本模块属于 io 层（允许碰文件），但**不 import `node:fs`**：知识库文件系统的唯一
 * 入口是 `vault.ts`，这里只用它给出的列目录与读文件函数。
 */

import type { NoteSummary } from '../core/contracts.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import { listNoteFiles, readText, vaultRelativePath } from './vault.js';
import type { VaultPaths } from './vault.js';

/**
 * 把 `notes/` 下的每一篇笔记读成一个 `NoteSummary`。
 *
 * 返回顺序**就是** `listNoteFiles` 的顺序（按文件名排序，确定且不看时钟）。
 * 排序是渲染层的责任，不是这里的——`show` 只筛选、不排序，`list` 有自己的一套
 * 主序次（契约 §11）。
 *
 * 三条约定：
 * - **读不懂不抛异常**：文件还在，只是解析不出来，于是 `frontmatter: null` +
 *   `problem`。浏览命令必须能把坏文件照常显示出来，静默吞掉才是最坏的结果。
 * - **不读时钟**：所有时间信息都来自 frontmatter 里的 `created`。
 * - **不改任何东西**：这是只读路径。
 */
export function readNoteSummaries(paths: VaultPaths): NoteSummary[] {
  const summaries: NoteSummary[] = [];

  for (const filePath of listNoteFiles(paths)) {
    const relativePath = vaultRelativePath(paths, filePath);

    let text: string;
    try {
      text = readText(filePath);
    } catch (error) {
      // 读不到（权限、刚好被删）也是「这一篇读不懂」，不是崩溃。
      summaries.push({
        path: filePath,
        relativePath,
        frontmatter: null,
        problem: `读不了这个文件：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed.ok) {
      summaries.push({ path: filePath, relativePath, frontmatter: null, problem: parsed.reason });
      continue;
    }

    summaries.push({ path: filePath, relativePath, frontmatter: parsed.frontmatter });
  }

  return summaries;
}

/**
 * 收集知识库里出现过的全部标签，去重后按**首次出现**的顺序返回。
 *
 * 它填的是提示词里的 `{{TAG_VOCABULARY}}`（契约 §4.7）——「让模型优先复用你已经
 * 用过的标签」这条设计全靠它。也正因为如此，它读的是**笔记本身**：
 * 台账可以整个删掉，而笔记文件代表了「用户实际用过的词」这件事的全部证据。
 *
 * 它和 `learnmate tags` 命令走的是**同一条路**（都经过 `readNoteSummaries`），
 * 所以用户看到的顺序和模型看到的顺序永远来自同一份数据，不会各说各话。
 *
 * 为什么顺序是「首次出现」而不是排好序：调用方 `renderTagVocabulary` 会自己
 * 去重并排成 UTF-16 升序，以保证同样的标签集永远拼出逐字符相同的提示词。
 * 这里再排一次只会在两处维护同一份规则，迟早分叉。
 *
 * 读不懂的笔记**跳过**：一篇坏文件不该让整次输入失去标签词表。
 * 坏在哪由 `doctor` 和 `list` 负责报告，不是这里。
 */
export function collectKnownTags(paths: VaultPaths): string[] {
  const tags = new Set<string>();

  for (const summary of readNoteSummaries(paths)) {
    if (summary.frontmatter === null) continue;

    for (const tag of summary.frontmatter.tags) {
      const trimmed = tag.trim();
      if (trimmed !== '') tags.add(trimmed);
    }
  }

  return [...tags];
}
