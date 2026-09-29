import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EXIT, UsageError } from '../src/core/errors.js';
import { ingest, normalizeText } from '../src/core/ingest.js';

/** 大多数用例不关心长度上限，给一个宽裕的默认值。 */
const LIMITS = { maxInputChars: 20_000 };

describe('normalizeText —— 规范化规则（契约第 5.5 节）', () => {
  it('CRLF 和 LF 规范化成完全一样的文本', () => {
    const lf = '第一行\n第二行\n\n第三行';
    const crlf = '第一行\r\n第二行\r\n\r\n第三行';
    assert.equal(normalizeText(crlf), normalizeText(lf));
  });

  it('老式 Mac 的裸 CR 也当成换行', () => {
    assert.equal(normalizeText('a\rb'), normalizeText('a\nb'));
  });

  it('去掉开头的 BOM', () => {
    assert.equal(normalizeText('\uFEFF你好'), '你好\n');
  });

  it('去掉正文里的零宽字符', () => {
    assert.equal(normalizeText('你\u200B好\u200D吗'), '你好吗\n');
  });

  it('去掉每行行尾的空白', () => {
    assert.equal(normalizeText('a   \nb\t\t'), 'a\nb\n');
  });

  it('连续 3 个以上换行折叠成 2 个', () => {
    assert.equal(normalizeText('a\n\n\n\n\nb'), 'a\n\nb\n');
  });

  it('一个空行（2 个换行）保持不变', () => {
    assert.equal(normalizeText('a\n\nb'), 'a\n\nb\n');
  });

  it('去掉整体首尾空白，末尾恰好一个换行', () => {
    assert.equal(normalizeText('\n\n  你好  \n\n\n'), '你好\n');
  });

  it('中文、日文、韩文、emoji 原样保留，不转码', () => {
    const text = '中文 日本語 한국어 🎨';
    assert.equal(normalizeText(text), `${text}\n`);
  });

  it('规范化是幂等的：再规范化一次不会再变', () => {
    const once = normalizeText('  a\r\n\r\n\r\n\r\nb  ');
    assert.equal(normalizeText(once), once);
  });
});

describe('ingest —— 指纹与长度守卫', () => {
  it('★ 同一段文字 CRLF 与 LF 得到同一个指纹（契约第 5.5 节点名要测的性质）', () => {
    const lf = ingest('甲：矢量软件；乙：位图软件。\n阶段一目标：位移效果。', LIMITS);
    const crlf = ingest('甲：矢量软件；乙：位图软件。\r\n阶段一目标：位移效果。', LIMITS);
    assert.equal(crlf.hash, lf.hash);
    assert.equal(crlf.normalized, lf.normalized);
  });

  it('指纹格式是 sha256: 加 64 位小写十六进制', () => {
    assert.match(ingest('hello', LIMITS).hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('内容相同则指纹相同', () => {
    assert.equal(ingest('同样的文字', LIMITS).hash, ingest('同样的文字', LIMITS).hash);
  });

  it('内容不同则指纹不同', () => {
    assert.notEqual(ingest('a', LIMITS).hash, ingest('b', LIMITS).hash);
  });

  it('行尾空格不影响指纹', () => {
    assert.equal(ingest('a   \nb', LIMITS).hash, ingest('a\nb', LIMITS).hash);
  });

  it('规范化文本末尾恰好一个换行', () => {
    assert.equal(ingest('a', LIMITS).normalized, 'a\n');
  });

  it('charCount 按 Unicode 码点算，末尾换行不算', () => {
    // 中 / 文 / 🎨 是 3 个码点。如果用 JS 的 .length（UTF-16 长度）会数成 4，
    // 🎨 这种星平面字符会被算成两个，中文笔记的字数就会虚高。
    assert.equal(ingest('中文🎨', LIMITS).charCount, 3);
  });

  it('正好等于上限时通过', () => {
    assert.equal(ingest('a'.repeat(10), { maxInputChars: 10 }).charCount, 10);
  });

  it('超过上限时抛 UsageError，退出码 2', () => {
    assert.throws(
      () => ingest('a'.repeat(11), { maxInputChars: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.match(error.message, /11 个字符/);
        assert.match(error.message, /上限 10/);
        assert.match(error.message, /不会截断/);
        return true;
      },
    );
  });

  it('超长时报错而不是把内容砍短', () => {
    const long = '字'.repeat(50);
    let threw = false;
    try {
      ingest(long, { maxInputChars: 10 });
    } catch {
      threw = true;
    }
    assert.ok(threw, '超长必须报错');
    // 反过来确认：没超的时候一个字都不许少。
    assert.equal(ingest(long, { maxInputChars: 50 }).charCount, 50);
  });

  it('报错信息里带上来源名，方便知道是哪份输入超了', () => {
    assert.throws(
      () => ingest('a'.repeat(11), { maxInputChars: 10, sourceLabel: '示例输入.txt' }),
      /来源：示例输入\.txt/,
    );
  });

  it('空输入不会崩，charCount 为 0', () => {
    const result = ingest('   \n\n  ', LIMITS);
    assert.equal(result.charCount, 0);
    assert.equal(result.normalized, '\n');
  });
});
