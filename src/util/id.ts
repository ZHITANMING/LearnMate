/**
 * ULID 生成（契约第 5.2 节）。
 *
 * 26 个字符：前 10 个是毫秒时间戳，后 16 个是随机数，都用 Crockford Base32 编码。
 *
 * 为什么要有这么个东西、而且**只在这里生成 id**：
 *   1. `core/` 里的函数被明令禁止读时钟、取随机数（架构硬约束第 2 条），
 *      所以「生成一个 id」这个动作必须有地方发生，而且不能发生在 core 里；
 *   2. id 出现在文件名（`<slug>-<id8>.md`）和 frontmatter 里，是笔记的骨架。
 *      生成规则散成两三处，早晚会出现「同一批笔记的 id 前缀不一样」这种怪事。
 *
 * **同一毫秒内的单调性**是这里唯一有点技术含量的部分，而且它不是学术问题：
 * 一次输入拆出的十几条笔记必然在同一毫秒内生成，如果随机部分纯随机，它们的大小
 * 关系就是乱的。契约要求「按时间单调递增」，所以同一毫秒内我们**递增随机部分**
 * 而不是重新抽一个——这样即使时间戳相同，后生成的 id 也一定大于先生成的。
 * （注意：这**不能**让 `id8` 后缀变得唯一，得由 pipeline 在写入前挡。）
 *
 * 本文件属于 util 层：允许读时钟、取随机数。
 */

import { randomBytes } from 'node:crypto';

/**
 * Crockford Base32 字母表。
 *
 * 去掉 `I` `L` `O` `U` 是为了让人读得起：`I`/`1`、`O`/`0` 长得太像，而 id 是要被人
 * 从文件名里念出来、抄下来的。
 *
 * 另一个不那么显眼但很重要的性质：**这张表是按 ASCII 升序排列的**。所以比较两个
 * ULID 字符串的大小，等价于比较它们代表的数字大小——文件名排序就是时间排序。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 编码基数，32。 */
const BASE = ENCODING.length;

/** ULID 总长度，26。 */
export const ULID_LENGTH = 26;

/** 前 10 个字符编码 48 位毫秒时间戳（10 × 5 = 50 位，头部两位恒为 0）。 */
const TIME_CHARS = 10;

/** 后 16 个字符编码 80 位随机数。 */
const RANDOM_CHARS = 16;

/** 48 位时间戳的上限，大约公元 10889 年。 */
const TIME_MAX = 2 ** 48 - 1;

/** 合法 ULID 的形状：26 位、Crockford Base32 大写。 */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 判断一个字符串是不是长得像合法 ULID。 */
export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * 时钟与随机数的来源。
 *
 * 存在的唯一理由是**测试**：不注入的话，「同一毫秒内递增」这条性质就没法稳定复现
 * （得靠连续快速调用去碰运气，而那正是最不可靠的测试）。生产代码永远不传这个参数。
 */
export interface UlidSource {
  /** 取当前毫秒时间戳。默认 `Date.now`。 */
  now?: () => number;
  /** 取 16 个 0–31 的整数。默认用 `crypto` 的随机字节。 */
  random?: () => readonly number[];
}

/** 上一次生成用的时间戳与随机部分，单调性的记忆就存在这里。 */
let lastTime = -1;
let lastRandom: number[] = [];

/**
 * 生成一个新的 ULID。
 *
 * 保证：返回值匹配 `ULID_PATTERN`，且**同一个进程内不会小于上一次的返回值**
 * （即使系统时钟往回跳，也只会停住、不会倒退）。
 */
export function newUlid(source: UlidSource = {}): string {
  const readClock = source.now ?? Date.now;
  const draw = source.random ?? randomIndices;

  const clock = readClock();
  if (!Number.isInteger(clock) || clock < 0 || clock > TIME_MAX) {
    // 真发生的话是系统时钟坏了，不是用户的操作问题。宁可炸掉也不写出一个假 id。
    throw new Error(`ULID 的时间戳超出范围：${String(clock)}`);
  }

  // 时钟往回跳时停在上一次的时间上：时间是单调的，哪怕系统时钟不是。
  let time = Math.max(clock, lastTime);
  let indices: number[];

  if (time === lastTime && lastRandom.length > 0) {
    const next = increment(lastRandom);
    if (next === null) {
      // 同一毫秒内把 2^80 个随机数用光了——现实中不可能发生。真发生了就借用下一毫秒，
      // 保证不倒退（这里宁可牺牲一点时间精度，也不破坏单调性）。
      time = lastTime + 1;
      indices = validateDraw(draw());
    } else {
      indices = next;
    }
  } else {
    indices = validateDraw(draw());
  }

  lastTime = time;
  lastRandom = indices;
  return `${encodeTime(time)}${encodeRandom(indices)}`;
}

// ————————————————————————————— 内部实现 —————————————————————————————

/** 默认的随机来源：每个字符一个字节，取模 32。 */
function randomIndices(): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  // 256 是 32 的整数倍，所以取模不会带来偏差（不需要拒绝采样）。
  return Array.from(bytes, (byte) => byte % BASE);
}

/** 把随机部分 +1（从最低位进位）。已经全是最大值时返回 `null`。 */
function increment(indices: readonly number[]): number[] | null {
  const next = [...indices];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const value = next[i] ?? 0;
    if (value < BASE - 1) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  return null;
}

/** 校验注入的随机数：个数与取值范围都要对，否则宁可当场炸掉。 */
function validateDraw(values: readonly number[]): number[] {
  if (values.length !== RANDOM_CHARS) {
    throw new Error(`ULID 的随机部分需要 ${String(RANDOM_CHARS)} 个值，拿到了 ${String(values.length)} 个。`);
  }
  return values.map((value) => {
    if (!Number.isInteger(value) || value < 0 || value >= BASE) {
      throw new Error(`ULID 随机部分的取值必须是 0–${String(BASE - 1)} 的整数，拿到了 ${String(value)}。`);
    }
    return value;
  });
}

/** 48 位时间戳 → 10 个字符，高位在前。 */
function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > TIME_MAX) {
    throw new Error(`ULID 的时间戳超出范围：${String(time)}`);
  }
  const chars: string[] = [];
  let remaining = time;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    chars.unshift(charAt(remaining % BASE));
    remaining = Math.floor(remaining / BASE);
  }
  return chars.join('');
}

/** 16 个下标 → 16 个字符。 */
function encodeRandom(indices: readonly number[]): string {
  return indices.map((index) => charAt(index)).join('');
}

function charAt(index: number): string {
  const char = ENCODING[index];
  if (char === undefined) throw new Error(`ULID 编码下标越界：${String(index)}`);
  return char;
}
