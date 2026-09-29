/**
 * 读提示词文件。
 *
 * 为什么单独一个文件：`prompts/` 不是知识库（知识库只有 `src/io/vault.ts` 能碰），
 * 它是随程序一起发布的**源码**。读它和读知识库是两件不同的事，混在一个模块里之后，
 * 「提示词文件丢了」和「知识库目录丢了」就很难分别给出对的提示。
 *
 * 组装（把占位符换成词表）**不在这里**，在 `src/core/prompt.ts` —— 那是纯逻辑。
 */

import { readFileSync } from 'node:fs';
import { UsageError, describeError } from '../core/errors.js';

/**
 * 读出提示词模板的原文。UTF-8，不做任何解析。
 *
 * 读不到就抛 `UsageError`（退出码 2）——**此时还没有任何写入，也没有发过任何请求**。
 */
export function readPromptTemplate(filePath: string, promptVersion: string): string {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(
        `找不到提示词文件：${filePath}\n` +
          `  配置里的 promptVersion 是「${promptVersion}」，对应 prompts/${promptVersion}.md。\n` +
          `  要检查两件事：\n` +
          `    1. 这个文件在不在（它应该跟着代码一起放在仓库里）；\n` +
          `    2. learnmate.config.json 里的 promptVersion 有没有写错——改了版本号就要有对应的新文件。`,
        { cause: error },
      );
    }
    throw new UsageError(`读不了提示词文件：${filePath}\n  ${describeError(error)}`, {
      cause: error,
    });
  }

  // 记事本一类编辑器会写 BOM，它会被原样当成提示词的第一个字符发出去。
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}
