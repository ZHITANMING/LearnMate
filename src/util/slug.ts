/**
 * 文件名清洗。
 *
 * 规则见 docs/03-contracts.md 第 5.3 节，共九步，**顺序本身也是规则的一部分**。
 *
 * 为什么这件小事值得单独一个文件、还配一整套测试：标题是用户随手起的，里面
 * 什么都可能有——冒号、问号、斜杠、换行、emoji，还有 `CON` 这种在 Windows 上
 * 永远建不出来的名字。清洗写错的表现是「某一条笔记就是存不进去」，而且往往是
 * 在你最需要翻它的时候才发现。
 *
 * 纯函数：不碰文件、不看时钟、不取随机数。
 */

/**
 * Windows 不允许作为文件名的词（第 6 步）。
 *
 * 注意 `COM0` 和 `COM10` 不在里面——微软留的坑只到 1–9。多写会误伤，
 * 比如把一条叫「COM10 接口」的笔记莫名其妙改名。
 */
const WINDOWS_RESERVED = new Set<string>([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

/** 第 2 步：这些字符在 Windows 上非法，在别的系统上也只会带来麻烦。 */
const ILLEGAL_CHARS = /[:*?"<>|/\\]/g;

/** 第 2 步的另一半：控制字符 U+0000–U+001F（换行、制表符、退格都在里面）。 */
const CONTROL_CHARS = /[\u0000-\u001F]/g;

/** 第 3 步：空白与下划线都变成一个 `-`。 */
const SEPARATORS = /[\s_]+/gu;

/** slug 最长多少个字符（Unicode 码点），契约第 5.3 节第 7 步。 */
export const SLUG_MAX_LENGTH = 60;

/** 清洗不出来任何东西时用的兜底名字（第 8 步）。 */
const FALLBACK_SLUG = 'note';

/**
 * 把用户起的标题变成一个能安全落盘的文件名片段。
 *
 * 不负责加扩展名、也不负责拼 id 后缀——那是 `noteFileName` 的事。
 * 保证的产物性质：不含 Windows 非法字符与控制字符、不含首尾 `-`、
 * 长度不超过 `SLUG_MAX_LENGTH` 个码点、且非空。
 */
export function slugify(title: string): string {
  // 1. 去掉首尾空白
  let slug = title.trim();

  // 2. 删掉非法字符与控制字符
  slug = slug.replace(ILLEGAL_CHARS, '');
  slug = slug.replace(CONTROL_CHARS, '');

  // 3. 空白与下划线 → 单个 `-`；4. 连续 `-` 折叠成一个；5. 去掉首尾 `-`
  slug = stripDashes(slug.replace(SEPARATORS, '-').replace(/-+/g, '-'));

  // 6. Windows 保留名前置 `n-`（忽略大小写比较，但保留用户原本的大小写）
  if (WINDOWS_RESERVED.has(slug.toLowerCase())) {
    slug = `n-${slug}`;
  }

  // 7. 按码点截断（`[...s]` 按码点遍历，不会把 emoji 从中间劈开）
  slug = truncateToCodePoints(slug, SLUG_MAX_LENGTH);

  // 截断可能刚好落在一个 `-` 上，把第 5 步的性质重新破坏掉。
  // 契约只写了「去首尾 `-`」，没有写「截断之后再去一次」——但第 5 步的意图
  // 显然是「产物不带首尾 `-`」，所以这里再走一遍，属于澄清而非改规则。
  slug = stripDashes(slug);

  // 8. 什么都不剩就用 `note`
  return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * 笔记文件名：`<slug>-<id8>.md`，`id8` = 笔记 id 前 8 字符转小写。
 *
 * `id8` 后缀不能省：它保证「标题一样但内容不同」的两条笔记不会互相覆盖。
 * 这也是为什么笔记 id 必须在写文件之前就定下来。
 */
export function noteFileName(title: string, noteId: string): string {
  return `${slugify(title)}-${noteId.slice(0, 8).toLowerCase()}.md`;
}

// ————————————————————————————— 内部实现 —————————————————————————————
/** 去掉首尾连续的 `-`。 */
function stripDashes(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

/** 按 Unicode 码点截断，不切开代理对（emoji、少数字体符号是代理对）。 */
function truncateToCodePoints(value: string, max: number): string {
  const codePoints = [...value];
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}
