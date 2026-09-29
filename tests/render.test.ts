import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Block, NoteDraft, NoteMeta } from '../src/core/contracts.js';
import { renderBody, renderNote } from '../src/core/render.js';

/* ------------------------------------------------------------------ *
 * 测试数据
 * ------------------------------------------------------------------ */

const ID = '01J8ZC9W2M4QX7V3KTB6NPRW5H';
const INPUT_ID = '01J8ZC4M7QX2V9K3TB6NPRW5HE';

function makeMeta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: ID,
    inputId: INPUT_ID,
    created: '2026-09-28T21:31:26+08:00',
    updated: '2026-09-28T21:31:26+08:00',
    status: 'processed',
    sourceHash: 'sha256:3f2a1c9b7e4d5a6f8c0b2e1d3a4f5c6b7e8d9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
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
    summary: '先抠出发光部分，再用 乙插件 让这部分发光；需在已有投影的基础上做。',
    language: 'zh',
    tags: ['AE', '边缘光', '插件'],
    blocks: [{ type: 'text', text: '前置条件：需先完成「素材加投影」。' }],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 契约第 3.4 节的示例
 * ------------------------------------------------------------------ */

describe('render：契约第 3.4 节的示例', () => {
  it('把契约里那条示例笔记逐字符渲染出来', () => {
    const draft = makeDraft({
      blocks: [
        { type: 'text', text: '前置条件：需先完成「素材加投影」。' },
        {
          type: 'steps',
          items: [
            '选中图层，Ctrl+D 复制后独显',
            '加（抠像）提取插件：选中独显图层，加提取',
            '调整参数：通道选择明亮度，拖动直方图下区域，提取出要发光部分',
            '加 乙插件 插件：选中独显图层，加 乙插件',
            '调整参数：发光半径、曝光（强度）、着色',
            '全选图层，右键变新的嵌套工程',
          ],
        },
        {
          type: 'params',
          items: [
            { name: '通道', value: '明亮度', note: '提取插件：按哪个通道抠' },
            { name: '发光半径', note: '乙插件' },
            { name: '曝光（强度）', note: '乙插件' },
            { name: '着色', note: '乙插件' },
          ],
        },
      ],
    });

    const expected = [
      '---',
      `id: ${ID}`,
      `input_id: ${INPUT_ID}`,
      'title: 素材加边缘光（提取 + 乙插件）',
      'created: 2026-09-28T21:31:26+08:00',
      'updated: 2026-09-28T21:31:26+08:00',
      'summary: 先抠出发光部分，再用 乙插件 让这部分发光；需在已有投影的基础上做。',
      'tags:',
      '  - AE',
      '  - 边缘光',
      '  - 插件',
      'status: processed',
      'source_hash: sha256:3f2a1c9b7e4d5a6f8c0b2e1d3a4f5c6b7e8d9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
      'source_ref: 示例输入.docx',
      'schema_version: 1',
      'language: zh',
      'model: deepseek-chat',
      'prompt_version: analyze.v1',
      '---',
      '',
      '# 素材加边缘光（提取 + 乙插件）',
      '',
      '> 先抠出发光部分，再用 乙插件 让这部分发光；需在已有投影的基础上做。',
      '',
      '前置条件：需先完成「素材加投影」。',
      '',
      '## 操作步骤',
      '',
      '1. 选中图层，Ctrl+D 复制后独显',
      '2. 加（抠像）提取插件：选中独显图层，加提取',
      '3. 调整参数：通道选择明亮度，拖动直方图下区域，提取出要发光部分',
      '4. 加 乙插件 插件：选中独显图层，加 乙插件',
      '5. 调整参数：发光半径、曝光（强度）、着色',
      '6. 全选图层，右键变新的嵌套工程',
      '',
      '## 参数',
      '',
      '| 参数 | 取值 | 说明 |',
      '|---|---|---|',
      '| 通道 | 明亮度 | 提取插件：按哪个通道抠 |',
      '| 发光半径 |  | 乙插件 |',
      '| 曝光（强度） |  | 乙插件 |',
      '| 着色 |  | 乙插件 |',
      '',
    ].join('\n');

    assert.equal(renderNote(draft, makeMeta()), expected);
  });
});

/* ------------------------------------------------------------------ *
 * 确定性
 * ------------------------------------------------------------------ */

describe('render：确定性', () => {
  it('同样的输入渲染两次，结果逐字符相同', () => {
    const draft = makeDraft({
      blocks: [
        { type: 'steps', items: ['一', '二'] },
        { type: 'concept', term: '嵌套工程', explanation: '把若干图层打包成一个新的合成。' },
        { type: 'uncertain', items: [{ text: '导出用 4K', reason: '不知指合成还是导出' }] },
      ],
    });
    const meta = makeMeta();
    assert.equal(renderNote(draft, meta), renderNote(draft, meta));
  });

  it('渲染结果不随时间变化：两次调用之间 created 不会被改写', () => {
    const draft = makeDraft();
    const meta = makeMeta();
    const first = renderNote(draft, meta);
    const second = renderNote(draft, meta);
    assert.ok(first.includes('created: 2026-09-28T21:31:26+08:00'));
    assert.equal(first, second);
  });

  it('文件末尾恰好一个换行符', () => {
    const output = renderNote(makeDraft(), makeMeta());
    assert.ok(output.endsWith('\n'), '应该以换行结尾');
    assert.ok(!output.endsWith('\n\n'), '不应该以两个换行结尾');
  });
});

/* ------------------------------------------------------------------ *
 * 空字段
 * ------------------------------------------------------------------ */

describe('render：空字段不产生空标题', () => {
  it('steps 没给 title 时用「操作步骤」', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'steps', items: ['一'] }] }));
    assert.ok(body.includes('## 操作步骤'));
  });

  it('steps 的 title 是空串时也用默认标题', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'steps', title: '', items: ['一'] }] }));
    assert.ok(body.includes('## 操作步骤'));
    assert.ok(!body.includes('## \n'), '不能出现空标题');
  });

  it('steps 的 title 全是空格时也用默认标题', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'steps', title: '   ', items: ['一'] }] }));
    assert.ok(body.includes('## 操作步骤'));
  });

  it('list 没给 title 时用「要点」', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'list', items: ['一'] }] }));
    assert.ok(body.includes('## 要点'));
  });

  it('params 没给 title 时用「参数」', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'params', items: [{ name: '通道' }] }] }));
    assert.ok(body.includes('## 参数'));
  });

  it('items 为空的 steps 整块不出现（不留一个空标题）', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'steps', items: [] }] }));
    assert.ok(!body.includes('## 操作步骤'));
    assert.ok(!body.includes('## \n'));
  });

  it('items 为空的 list 与 params 整块不出现', () => {
    const body = renderBody(
      makeDraft({ blocks: [{ type: 'list', items: [] }, { type: 'params', items: [] }] }),
    );
    assert.ok(!body.includes('## 要点'));
    assert.ok(!body.includes('## 参数'));
  });

  it('text 全是空白时不产生一个空段落', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'text', text: '   ' }] }));
    assert.equal(body, `# 素材加边缘光（提取 + 乙插件）\n\n> 先抠出发光部分，再用 乙插件 让这部分发光；需在已有投影的基础上做。\n`);
  });

  it('summary 为空时不产生一个空的引用块', () => {
    const body = renderBody(makeDraft({ summary: '', blocks: [] }));
    assert.ok(!body.includes('>'));
    assert.equal(body, '# 素材加边缘光（提取 + 乙插件）\n');
  });

  it('term 为空的 concept 整块不出现', () => {
    const body = renderBody(
      makeDraft({ blocks: [{ type: 'concept', term: '  ', explanation: '解释' }] }),
    );
    assert.ok(!body.includes('###'));
  });

  it('没有任何块时，正文只有标题和摘要', () => {
    const body = renderBody(makeDraft({ blocks: [] }));
    assert.equal(body.split('\n').filter((line) => line.startsWith('##')).length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * 块渲染
 * ------------------------------------------------------------------ */

describe('render：各类块', () => {
  it('steps 用有序列表，编号从 1 开始连续', () => {
    const body = renderBody(
      makeDraft({ blocks: [{ type: 'steps', items: ['甲', '乙', '丙'] }] }),
    );
    assert.ok(body.includes('1. 甲\n2. 乙\n3. 丙'));
  });

  it('list 用无序列表', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'list', items: ['甲', '乙'] }] }));
    assert.ok(body.includes('- 甲\n- 乙'));
  });

  it('concept 只产生 ### 标题，不产生 ## 标题', () => {
    const body = renderBody(
      makeDraft({ blocks: [{ type: 'concept', term: '嵌套工程', explanation: '把图层打包。' }] }),
    );
    assert.ok(body.includes('### 嵌套工程\n\n把图层打包。'));
    // 注意不能用 includes('## 嵌套工程')：'### 嵌套工程' 里本来就含这个子串。按行判断。
    assert.ok(!body.split('\n').some((line) => line.startsWith('## ')));
  });

  it('params 渲染成三列表格，取值与说明可以留空', () => {
    const body = renderBody(
      makeDraft({
        blocks: [{ type: 'params', items: [{ name: '发光半径' }, { name: '通道', value: '明亮度' }] }],
      }),
    );
    assert.ok(body.includes('| 参数 | 取值 | 说明 |\n|---|---|---|'));
    assert.ok(body.includes('| 发光半径 |  |  |'));
    assert.ok(body.includes('| 通道 | 明亮度 |  |'));
  });

  it('表格单元格里的竖线会被转义，不会把表格劈开', () => {
    const body = renderBody(
      makeDraft({ blocks: [{ type: 'params', items: [{ name: '通道', value: 'R|G|B' }] }] }),
    );
    assert.ok(body.includes('| 通道 | R\\|G\\|B |  |'));
  });

  it('块的先后顺序按 blocks 数组来', () => {
    const body = renderBody(
      makeDraft({
        blocks: [{ type: 'list', title: '甲', items: ['一'] }, { type: 'list', title: '乙', items: ['二'] }],
      }),
    );
    assert.ok(body.indexOf('## 甲') < body.indexOf('## 乙'));
  });

  it('正文首行与 frontmatter 的 title 逐字符一致', () => {
    const draft = makeDraft({ title: '工具基础设置' });
    const output = renderNote(draft, makeMeta());
    const lines = output.split('\n');
    const titleLine = lines.find((line) => line.startsWith('title: '));
    const headingLine = lines.find((line) => line.startsWith('# '));
    assert.equal(titleLine, 'title: 工具基础设置');
    assert.equal(headingLine, '# 工具基础设置');
  });
});

/* ------------------------------------------------------------------ *
 * 待确认
 * ------------------------------------------------------------------ */

describe('render：待确认', () => {
  it('uncertain 排在 blocks 中间也会被挪到文末', () => {
    const body = renderBody(
      makeDraft({
        blocks: [
          { type: 'uncertain', items: [{ text: '导出用 4K', reason: '不知指哪个尺寸' }] },
          { type: 'list', title: '要点', items: ['一'] },
        ],
      }),
    );
    assert.ok(body.indexOf('## 待确认') > body.indexOf('## 要点'));
  });

  it('按契约第 3.3 节的格式渲染，缩进两格', () => {
    const body = renderBody(
      makeDraft({
        blocks: [
          {
            type: 'uncertain',
            items: [
              { text: '导出清晰：尺寸选择 4K，等比例放大', reason: '4K 指合成尺寸还是导出尺寸，原文没有说明' },
            ],
          },
        ],
      }),
    );
    assert.ok(
      body.includes(
        '## 待确认\n\n- 导出清晰：尺寸选择 4K，等比例放大\n  - 存疑原因：4K 指合成尺寸还是导出尺寸，原文没有说明\n',
      ),
    );
  });

  it('用户选择改写时追加「更正为」一行', () => {
    const body = renderBody(
      makeDraft({
        blocks: [
          {
            type: 'uncertain',
            items: [{ text: '导出用 4K', reason: '指代不明', resolution: '指合成尺寸' }],
          },
        ],
      }),
    );
    assert.ok(body.includes('  - 更正为：指合成尺寸'));
  });

  it('多个 uncertain 块合并成一个「待确认」，一条都不丢', () => {
    const body = renderBody(
      makeDraft({
        blocks: [
          { type: 'uncertain', items: [{ text: '甲', reason: '原因甲' }] },
          { type: 'uncertain', items: [{ text: '乙', reason: '原因乙' }] },
        ],
      }),
    );
    assert.equal(body.split('## 待确认').length - 1, 1);
    assert.ok(body.includes('- 甲'));
    assert.ok(body.includes('- 乙'));
  });

  it('没有 uncertain 块时不出现「待确认」标题', () => {
    const body = renderBody(makeDraft());
    assert.ok(!body.includes('## 待确认'));
  });

  it('items 为空的 uncertain 不产生一个空标题', () => {
    const body = renderBody(makeDraft({ blocks: [{ type: 'uncertain', items: [] }] }));
    assert.ok(!body.includes('## 待确认'));
  });
});

/* ------------------------------------------------------------------ *
 * 语言
 * ------------------------------------------------------------------ */

describe('render：语言', () => {
  it('language 为 en 时用英文默认标题', () => {
    const body = renderBody(
      makeDraft({
        language: 'en',
        blocks: [
          { type: 'steps', items: ['one'] },
          { type: 'list', items: ['two'] },
          { type: 'params', items: [{ name: 'Radius' }] },
          { type: 'uncertain', items: [{ text: 'maybe', reason: 'unclear', resolution: 'it means size' }] },
        ],
      }),
    );
    assert.ok(body.includes('## Steps'));
    assert.ok(body.includes('## Key Points'));
    assert.ok(body.includes('## Parameters'));
    assert.ok(body.includes('## Open Questions'));
    assert.ok(body.includes('| Parameter | Value | Note |'));
    assert.ok(body.includes('  - Uncertain because: unclear'));
    assert.ok(body.includes('  - Corrected to: it means size'));
    assert.ok(!body.includes('操作步骤'));
  });

  it('模型自己给了标题时，语言不影响它', () => {
    const body = renderBody(
      makeDraft({ language: 'en', blocks: [{ type: 'steps', title: '操作步骤', items: ['x'] }] }),
    );
    assert.ok(body.includes('## 操作步骤'));
  });
});

/* ------------------------------------------------------------------ *
 * YAML 安全
 * ------------------------------------------------------------------ */

describe('render：YAML 安全', () => {
  it('标题里带 ": " 时加引号，不让 frontmatter 被毁掉', () => {
    const output = renderNote(makeDraft({ title: '新建: 尺寸 1920' }), makeMeta());
    assert.ok(output.includes('title: "新建: 尺寸 1920"'));
  });

  it('摘要里带 ": " 时加引号', () => {
    const output = renderNote(makeDraft({ summary: '注意: 先复制图层' }), makeMeta());
    assert.ok(output.includes('summary: "注意: 先复制图层"'));
  });

  it('以 YAML 结构符号开头的值加引号', () => {
    const output = renderNote(makeDraft({ title: '- 未命名' }), makeMeta());
    assert.ok(output.includes('title: "- 未命名"'));
  });

  it('长得像数字或布尔的标题加引号，免得被解析成数字/布尔', () => {
    assert.ok(renderNote(makeDraft({ title: '2026' }), makeMeta()).includes('title: "2026"'));
    assert.ok(renderNote(makeDraft({ title: 'true' }), makeMeta()).includes('title: "true"'));
  });

  it('带引号的标题里的引号会被转义', () => {
    const output = renderNote(makeDraft({ title: '他说: "先复制"' }), makeMeta());
    assert.ok(output.includes('title: "他说: \\"先复制\\""'));
  });

  it('标签也走同一套引号规则', () => {
    const output = renderNote(makeDraft({ tags: ['AE', '2026'] }), makeMeta());
    assert.ok(output.includes('  - AE\n  - "2026"'));
  });

  it('正常中文标题不加多余的引号', () => {
    const output = renderNote(makeDraft({ title: 'AE 新建工程与导入素材' }), makeMeta());
    assert.ok(output.includes('title: AE 新建工程与导入素材'));
  });
});

/* ------------------------------------------------------------------ *
 * 守卫
 * ------------------------------------------------------------------ */

describe('render：拒绝渲染必然是坏文件的输入', () => {
  it('标题里有换行符时当场报错，而不是写出一个坏文件', () => {
    assert.throws(() => renderNote(makeDraft({ title: '甲\n乙' }), makeMeta()), /换行符/);
  });

  it('步骤条目里有换行符时报错', () => {
    assert.throws(
      () => renderBody(makeDraft({ blocks: [{ type: 'steps', items: ['甲\n乙'] }] })),
      /换行符/,
    );
  });

  it('frontmatter 字段里有换行符时报错', () => {
    assert.throws(() => renderNote(makeDraft(), makeMeta({ model: 'a\nb' })), /换行符/);
  });

  it('source_ref 带路径时报错，因为它不该泄露目录结构', () => {
    assert.throws(
      () => renderNote(makeDraft(), makeMeta({ sourceRef: 'C:\\课程\\示例输入.docx' })),
      /只允许存文件名/,
    );
  });

  it('不传 source_ref 时不产生该字段', () => {
    const meta = makeMeta();
    delete (meta as { sourceRef?: string }).sourceRef;
    const output = renderNote(makeDraft(), meta);
    assert.ok(!output.includes('source_ref'));
  });
});

/* ------------------------------------------------------------------ *
 * frontmatter 结构
 * ------------------------------------------------------------------ */

describe('render：frontmatter', () => {
  it('用 --- 包围，与正文之间空一行', () => {
    const output = renderNote(makeDraft(), makeMeta());
    assert.ok(output.startsWith('---\n'));
    assert.ok(output.includes('\n---\n\n# '));
  });

  it('字段顺序固定，同一份草稿的 diff 才稳定', () => {
    const output = renderNote(makeDraft(), makeMeta());
    const keys = output
      .split('\n')
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
    assert.deepEqual(keys, [
      'id',
      'input_id',
      'title',
      'created',
      'updated',
      'summary',
      'tags',
      'status',
      'source_hash',
      'source_ref',
      'schema_version',
      'language',
      'model',
      'prompt_version',
    ]);
  });

  it('status 与 language 直接照抄，不加引号', () => {
    const output = renderNote(makeDraft(), makeMeta({ status: 'inbox' }));
    assert.ok(output.includes('status: inbox'));
    assert.ok(output.includes('language: zh'));
  });

  it('schema_version 是数字，不是字符串', () => {
    const output = renderNote(makeDraft(), makeMeta({ schemaVersion: 1 }));
    assert.ok(output.includes('schema_version: 1'));
    assert.ok(!output.includes('schema_version: "1"'));
  });
});
