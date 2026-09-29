import { createHash } from 'node:crypto';

/**
 * 内容指纹：规范化文本按 UTF-8 编码后的 SHA-256，表示成 `sha256:<64 位小写十六进制>`。
 *
 * 契约见 docs/03-contracts.md 第 5.4 节。一次输入产出的**全部**笔记共享同一个指纹——
 * 它标识的是「你交给工具的这段文字」，不是某一条笔记。
 *
 * 注意它算的是**规范化之后**的文本。同一段文字用 CRLF 存还是 LF 存，指纹必须一样，
 * 这是契约里点名要写测试的关键性质。
 */
export function fingerprint(text: string): string {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hex}`;
}
