/**
 * `util/id.ts` 的测试。
 *
 * 这里钉的都是「id 万一出问题会很难查」的性质：
 *   1. 形状对——26 位、Crockford Base32 大写，不含容易看错的 I / L / O / U；
 *   2. **同一毫秒内单调递增**——一次输入拆出的十几条笔记就发生在同一毫秒里，
 *      如果随机部分是纯随机的，它们的大小关系就是乱的，而文件名排序本该就是时间排序；
 *   3. 系统时钟往回跳时不倒退（这种事在虚拟机和笔记本休眠后真的会发生）。
 *
 * 时间与随机数都是注入的：不注入就只能靠「连续快速调用碰运气」来复现单调性，
 * 而那正是最不可靠的一种测试。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ULID_LENGTH, ULID_PATTERN, isUlid, newUlid } from '../src/util/id.js';

/**
 * 单调性的记忆（`lastTime`）存在模块里、跨用例共享，所以每个用例都得用一个
 * 比之前都大的时间戳——否则注入的随机数根本不会被采用（会走「递增」那条路）。
 * 起点放在真实时钟之后，保证跟不注入时钟的用例也不打架。
 */
let clock = Date.now() + 1_000_000;

function freshTime(): number {
  clock += 1_000;
  return clock;
}

/** 16 个相同的随机值，方便复现。 */
function fixedRandom(value: number): () => readonly number[] {
  return () => Array.from({ length: 16 }, () => value);
}

describe('ULID：形状', () => {
  it('26 位，且全是 Crockford Base32 大写字符', () => {
    const id = newUlid();
    assert.equal(id.length, ULID_LENGTH);
    assert.match(id, ULID_PATTERN);
    assert.ok(isUlid(id));
  });

  it('长得像但不是的字符串要认出来', () => {
    assert.equal(isUlid('01J8ZK4M2Q7V9N3P5R7T9W2X4Y'), true);
    assert.equal(isUlid('01J8ZK4M2Q7V9N3P5R7T9W2X4I'), false, 'I 不在字母表里');
    assert.equal(isUlid('01J8ZK4M2Q7V9N3P5R7T9W2X4l'), false, '小写不算');
    assert.equal(isUlid('01J8ZK4M2Q7V9N3P5R7T9W2X4'), false, '少一位不算');
    assert.equal(isUlid(''), false);
  });
});

describe('ULID：同一毫秒内单调递增', () => {
  it('时间戳不动时，后生成的 id 一定更大（靠递增随机部分，不是重抽）', () => {
    const at = freshTime();
    const now = (): number => at;

    const first = newUlid({ now, random: fixedRandom(0) });
    const second = newUlid({ now, random: fixedRandom(0) });
    const third = newUlid({ now, random: fixedRandom(0) });

    assert.equal(first.slice(0, 10), second.slice(0, 10), '同一毫秒的时间前缀应该相同');
    assert.ok(second > first, `${second} 应该大于 ${first}`);
    assert.ok(third > second, `${third} 应该大于 ${second}`);
  });

  it('一万个也不重样', () => {
    const at = freshTime();
    const ids = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) ids.add(newUlid({ now: () => at }));
    assert.equal(ids.size, 10_000);
  });

  it('时间部分跟着注入的时间走', () => {
    const at = freshTime();
    const first = newUlid({ now: () => at, random: fixedRandom(0) });
    const second = newUlid({ now: () => at, random: fixedRandom(0) });
    const later = newUlid({ now: () => at + 1, random: fixedRandom(0) });

    assert.equal(first.slice(0, 10), second.slice(0, 10));
    assert.notEqual(first.slice(0, 10), later.slice(0, 10), '换一毫秒，前缀就该换');
    assert.ok(later > second);
  });

  it('系统时钟往回跳时停住，不生成倒退的 id', () => {
    const at = freshTime();
    const first = newUlid({ now: () => at, random: fixedRandom(3) });
    const jumped = newUlid({ now: () => at - 1_000, random: fixedRandom(3) });

    assert.equal(first.slice(0, 10), jumped.slice(0, 10), '时间前缀应该停在上一次，而不是倒退');
    assert.ok(jumped > first);
  });
});

describe('ULID：注入的坏值宁可当场炸掉', () => {
  it('随机数个数不对', () => {
    const at = freshTime();
    assert.throws(() => newUlid({ now: () => at, random: () => [0, 1, 2] }), /16 个值/);
  });

  it('随机数取值越界', () => {
    const at = freshTime();
    assert.throws(
      () => newUlid({ now: () => at, random: fixedRandom(32) }),
      /ULID 随机部分/,
    );
  });

  it('时间戳超出 48 位范围', () => {
    assert.throws(() => newUlid({ now: () => -1 }), /超出范围/);
  });
});
