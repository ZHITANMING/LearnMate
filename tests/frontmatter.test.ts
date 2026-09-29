/**
 * `core/frontmatter.ts` 的测试。
 *
 * 这里最重要的一个用例是**往返**：`render` 写出去、`parseFrontmatter` 读回来，
 * 每个字段都必须一模一样。这条测试之所以值钱，是因为它同时钉住了两个方向的代码——
 * 任何一边悄悄改了引号规则或转义规则，它都会当场报红。
 *
 * 其余用例全部是「看不懂就说看不懂」：宁可返回失败原因，绝不返回半个对象，
 * 因为调用方（`rebuild-index`）会拿这个对象去写台账。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFrontmatter } from '../src/core/frontmatter.js';
import { renderNote } from '../src/core/render.js';
import type { NoteDraft, NoteMeta } from '../src/core/contracts.js';

const ID = '01J8ZC9W2M4QX7V3KTB6NPRW5H';
const INPUT_ID = '01J8ZC4M7QX2V9K3TB6NPRW5HE';

function makeMeta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: ID,
    inputId: INPUT_ID,
    created: '2026-09-28T21:31:26+08:00',
    updated: '2026-09-28T21:31:26+08:00',
    status: 'processed',
    sourceHash: 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e',
    sourceRef: '示例输入.docx',
    schemaVersion: 1,
    model: 'deepseek-chat',
    promptVersion: 'analyze.v1',
    ...overrides,
  };
}

function makeDraft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    title: '素材加边缘光（提取 + 乙插件）',
    summary: '抠出发光部分再让它发光，注意要在阴影的基础上做。',
    language: 'zh',
    tags: ['AE', '边缘光', '插件'],
    blocks: [{ type: 'text', text: '前置条件：先加好阴影。' }],
    ...overrides,
  };
}

/** 走一遍完整的 render → parse，失败即抛错，省掉每个用例里的 if。 */
function roundTrip(draft: NoteDraft, meta: NoteMeta): ReturnType<typeof parseFrontmatter> {
  return parseFrontmatter(renderNote(draft, meta));
}

describe('往返：render 写出去、parseFrontmatter 读回来', () => {
  it('普通标题，每个字段都原样回来', () => {
    const result = roundTrip(makeDraft(), makeMeta());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.frontmatter, {
      id: ID,
      input_id: INPUT_ID,
      title: '素材加边缘光（提取 + 乙插件）',
      created: '2026-09-28T21:31:26+08:00',
      updated: '2026-09-28T21:31:26+08:00',
      summary: '抠出发光部分再让它发光，注意要在阴影的基础上做。',
      tags: ['AE', '边缘光', '插件'],
      status: 'processed',
      source_hash: 'sha256:3f2a1c9b8d7e6f504132537465768798a9b0c1d2e3f405162738495a6b7c8d9e',
      source_ref: '示例输入.docx',
      schema_version: 1,
      language: 'zh',
      model: 'deepseek-chat',
      prompt_version: 'analyze.v1',
    });
  });

  it('标题里带 ASCII 冒号（会被加引号）也能原样回来', () => {
    // 这是 D18 的场景：不加引号的话整段 frontmatter 都是非法 YAML。
    const result = roundTrip(makeDraft({ title: '新建: 尺寸 1920 × 1080' }), makeMeta());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.title, '新建: 尺寸 1920 × 1080');
  });

  it('summary 里的冒号与引号都原样回来', () => {
    const summary = '他说: "先按住 Alt"，然后拖。';
    const result = roundTrip(makeDraft({ summary }), makeMeta());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.summary, summary);
  });

  it('标题看起来像数字也不会被变成数字', () => {
    const result = roundTrip(makeDraft({ title: '2026' }), makeMeta());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.title, '2026');
  });

  it('标签里带逗号或冒号也原样回来', () => {
    const tags = ['参数: wave weight', 'a, b', 'AN'];
    const result = roundTrip(makeDraft({ tags }), makeMeta());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.frontmatter.tags, tags);
  });

  it('没有 source_ref 时字段就不出现（而不是空字符串）', () => {
    const meta = makeMeta();
    delete (meta as { sourceRef?: string }).sourceRef;
    const result = roundTrip(makeDraft(), meta);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.source_ref, undefined);
  });
});

describe('parseFrontmatter：看不懂就说看不懂', () => {
  const valid = [
    '---',
    `id: ${ID}`,
    'input_id: ' + INPUT_ID,
    'title: 标题',
    'created: 2026-09-28T21:31:26+08:00',
    'updated: 2026-09-28T21:31:26+08:00',
    'summary: 一句话',
    'tags:',
    '  - AE',
    'status: processed',
    'source_hash: sha256:abc',
    'schema_version: 1',
    'language: zh',
    'model: deepseek-chat',
    'prompt_version: analyze.v1',
    '---',
    '',
    '# 标题',
    '',
  ].join('\n');

  it('一份手写的正常文件能读出来', () => {
    const result = parseFrontmatter(valid);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.id, ID);
    assert.deepEqual(result.frontmatter.tags, ['AE']);
    assert.equal(result.frontmatter.input_id, INPUT_ID);
  });

  it('没有 input_id 的旧文件照样能读（它是后加的字段）', () => {
    const withoutInputId = valid.replace(`input_id: ${INPUT_ID}\n`, '');
    const result = parseFrontmatter(withoutInputId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.input_id, undefined);
  });

  it('容忍 CRLF（契约要求写 LF，但用户可能用别的编辑器存过）', () => {
    const result = parseFrontmatter(valid.replace(/\n/g, '\r\n'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.title, '标题');
  });

  it('多出来的未知字段不报错（为将来的 schema 留路）', () => {
    const withExtra = valid.replace('status: processed\n', 'status: processed\nfuture_field: 随便\n');
    const result = parseFrontmatter(withExtra);
    assert.equal(result.ok, true);
  });

  it('不是以 --- 开头 → 说清楚', () => {
    const result = parseFrontmatter('# 就是一篇没有 frontmatter 的 Markdown\n');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /不是以 --- 开头/);
  });

  it('只有开头的 --- → 说清楚', () => {
    const result = parseFrontmatter('---\nid: x\n');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /找不到结束的 ---/);
  });

  it('缺必填字段 → 把缺的名字全列出来', () => {
    const missing = valid.replace('title: 标题\n', '').replace('model: deepseek-chat\n', '');
    const result = parseFrontmatter(missing);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /title/);
    assert.match(result.reason, /model/);
  });

  it('某一不是「键: 值」→ 报出行号，方便直接去看那一行', () => {
    const broken = valid.replace('status: processed\n', 'status processed\n');
    const result = parseFrontmatter(broken);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /第 10 行/);
  });

  it('schema_version 不是整数 → 拒绝', () => {
    const result = parseFrontmatter(valid.replace('schema_version: 1', 'schema_version: 一'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /schema_version/);
  });

  it('tags 写成一行标量而不是列表 → 拒绝', () => {
    const result = parseFrontmatter(valid.replace('tags:\n  - AE\n', 'tags: AE\n'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /tags/);
  });

  it('tags 是空列表时读出空数组（空标签是上层要挡的事，不是解析器的）', () => {
    const result = parseFrontmatter(valid.replace('tags:\n  - AE\n', 'tags:\n'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.frontmatter.tags, []);
  });
});
