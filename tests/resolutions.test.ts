/**
 * `core/resolutions.ts` 的测试 —— 存疑项裁定的形状校验与重放（T13 / 契约第 12 节）。
 *
 * 这一层是纯函数：没有磁盘、没有终端、没有时钟。用例里关心的是两类问题：
 *   ① 什么样的字节**不算**一份合法的裁定文件（宁可说不认，也不许静默套错）；
 *   ② 套裁定的时候，对不上草稿的那些记录**降级**成了什么，以及传进来的草稿
 *      有没有被就地改掉（重放会被调两次：预览一次、写盘一次）。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  NoteDraft,
  NoteRulings,
  ResolutionFile,
  UncertainItem,
} from '../src/core/contracts.js';
import { applyRulings, parseResolutionFile } from '../src/core/resolutions.js';

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

const INPUT_ID = '01J8ZK4M2Q7V9N3P5R7T9W2X01';
const TS = '2026-09-30T12:00:00+08:00';

/** 一条带 `count` 个存疑项的草稿：`存疑一`、`存疑二`……编号从 1 起。 */
function draftWithUncertain(count: number, extras: unknown[] = []): NoteDraft {
  const items: UncertainItem[] = [];
  for (let index = 1; index <= count; index += 1) {
    items.push({ text: `存疑${String(index)}`, reason: `原因${String(index)}` });
  }
  return {
    title: '样本笔记',
    summary: '一句话总结。',
    language: 'zh',
    tags: ['AE'],
    blocks: [
      { type: 'text', text: '正文。' },
      { type: 'uncertain', items },
      ...(extras as NoteDraft['blocks']),
    ],
  };
}

function rulingsOf(items: NoteRulings['items']): NoteRulings {
  return { note_index: 1, items };
}

/** 读一份「应该是合法的」裁定文件，失败时把问题一起抛出来方便定位。 */
function mustParse(value: unknown): ResolutionFile {
  const parsed = parseResolutionFile(value);
  if (!parsed.ok) {
    throw new Error(`本该读得懂，却报了：${parsed.problems.join(' / ')}`);
  }
  return parsed.file;
}

function problemsOf(value: unknown): readonly string[] {
  const parsed = parseResolutionFile(value);
  if (parsed.ok) throw new Error('本该读不懂，却读懂了');
  return parsed.problems;
}

/** 一份合法裁定文件的底稿，用例按需覆盖字段。 */
function fileObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_id: INPUT_ID,
    ts: TS,
    notes: [
      {
        note_index: 1,
        items: [{ item_index: 1, text: '存疑1', action: 'drop' }],
      },
    ],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * parseResolutionFile：形状
 * ------------------------------------------------------------------ */

describe('parseResolutionFile —— 什么样的字节算一份裁定文件', () => {
  it('合法文件：原样读回来，字段一个不少', () => {
    const file = mustParse(
      fileObject({
        notes: [
          {
            note_index: 2,
            items: [
              { item_index: 1, text: '存疑1', action: 'drop' },
              { item_index: 3, text: '存疑3', action: 'edit', resolution: '更正后的话。' },
            ],
          },
        ],
      }),
    );

    assert.equal(file.input_id, INPUT_ID);
    assert.equal(file.ts, TS);
    assert.equal(file.notes.length, 1);
    assert.equal(file.notes[0]?.note_index, 2);
    assert.deepEqual(file.notes[0]?.items, [
      { item_index: 1, text: '存疑1', action: 'drop' },
      { item_index: 3, text: '存疑3', action: 'edit', resolution: '更正后的话。' },
    ]);
  });

  it('顶层不是对象：报出来并说清现在是什么', () => {
    assert.ok(problemsOf(null)[0]?.includes('顶层必须是一个 JSON 对象'));
    assert.ok(problemsOf([])[0]?.includes('数组'));
    assert.ok(problemsOf('x')[0]?.includes('字符串'));
  });

  it('缺 input_id 或缺 ts：两条问题一起报，不藏在后面', () => {
    const problems = problemsOf({ notes: [] });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((problem) => problem.includes('`input_id`')));
    assert.ok(problems.some((problem) => problem.includes('`ts`')));
  });

  it('notes 不是数组：直接停下（没法逐条报）', () => {
    const problems = problemsOf(fileObject({ notes: {} }));
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('`notes` 必须是数组'));
  });

  it('note_index 不是 1 起的整数：这一篇整条不要，其余照报', () => {
    const problems = problemsOf(
      fileObject({
        notes: [
          { note_index: 0, items: [] },
          { note_index: 1, items: [] },
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('notes[0].note_index'));
  });

  it('items 不是数组：报出来', () => {
    const problems = problemsOf(fileObject({ notes: [{ note_index: 1, items: 'nope' }] }));
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('items 必须是数组'));
  });

  it('action 不认识：把允许的取值列出来', () => {
    const problems = problemsOf(
      fileObject({
        notes: [{ note_index: 1, items: [{ item_index: 1, text: '存疑1', action: 'keep' }] }],
      }),
    );
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('`drop` 或 `edit`'));
    assert.ok(problems[0]?.includes('keep'), '要说清现在是什么');
  });

  it('item_index 缺失或不是正整数：报出来', () => {
    const problems = problemsOf(
      fileObject({
        notes: [
          { note_index: 1, items: [{ text: '存疑1', action: 'drop' }] },
          { note_index: 2, items: [{ item_index: 1.5, text: '存疑1', action: 'drop' }] },
        ],
      }),
    );
    assert.equal(problems.length, 2);
    assert.ok(problems[0]?.includes('item_index 必须是 1 起的整数'));
  });

  it('text 不是字符串：报出来（它是重放时的校验坐标，不能缺）', () => {
    const problems = problemsOf(
      fileObject({ notes: [{ note_index: 1, items: [{ item_index: 1, action: 'drop' }] }] }),
    );
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('text 必须是字符串'));
  });

  it('resolution 给了但不是字符串：报出来', () => {
    const problems = problemsOf(
      fileObject({
        notes: [
          {
            note_index: 1,
            items: [{ item_index: 1, text: '存疑1', action: 'edit', resolution: 42 }],
          },
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('resolution 必须是字符串'));
  });

  it('空的 notes 数组是合法的：没有裁定，不是坏文件', () => {
    const file = mustParse(fileObject({ notes: [] }));
    assert.deepEqual(file.notes, []);
  });
});

/* ------------------------------------------------------------------ *
 * applyRulings：重放
 * ------------------------------------------------------------------ */

describe('applyRulings —— 把裁定套到草稿上', () => {
  it('没有裁定（null）：原样返回同一份草稿，零警告', () => {
    const draft = draftWithUncertain(2);
    const result = applyRulings(draft, 1, null, INPUT_ID);

    assert.equal(result.draft, draft, '没有任何裁定时不复制，直接返回原对象');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.applied, 0);
  });

  it('裁定文件里 items 为空：等同于没有裁定', () => {
    const draft = draftWithUncertain(2);
    const result = applyRulings(draft, 1, rulingsOf([]), INPUT_ID);

    assert.equal(result.draft, draft);
    assert.equal(result.applied, 0);
  });

  it('drop：那一条真的从草稿里消失，别的块一个字节都不动', () => {
    const draft = draftWithUncertain(2);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([{ item_index: 1, text: '存疑1', action: 'drop' }]),
      INPUT_ID,
    );

    const block = result.draft.blocks.find((candidate) => candidate.type === 'uncertain');
    assert.deepEqual(block, {
      type: 'uncertain',
      items: [{ text: '存疑2', reason: '原因2' }],
    });
    assert.equal(result.applied, 1);
    assert.deepEqual(result.warnings, []);

    // 传进来的那份没被动过。
    const original = draft.blocks.find((candidate) => candidate.type === 'uncertain');
    assert.deepEqual(original, {
      type: 'uncertain',
      items: [
        { text: '存疑1', reason: '原因1' },
        { text: '存疑2', reason: '原因2' },
      ],
    });
  });

  it('edit：那是给该条补上 resolution，原来的 text/reason 都还在', () => {
    const draft = draftWithUncertain(1);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([
        { item_index: 1, text: '存疑1', action: 'edit', resolution: '  用户写的那句话  ' },
      ]),
      INPUT_ID,
    );

    const block = result.draft.blocks.find((candidate) => candidate.type === 'uncertain');
    assert.deepEqual(block, {
      type: 'uncertain',
      items: [{ text: '存疑1', reason: '原因1', resolution: '用户写的那句话' }],
    });
    assert.equal(result.applied, 1);
  });

  it('同一篇上 drop 与 edit 混用：各自落在自己那一条上', () => {
    const draft = draftWithUncertain(3);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([
        { item_index: 1, text: '存疑1', action: 'drop' },
        { item_index: 3, text: '存疑3', action: 'edit', resolution: '第三条的更正。' },
      ]),
      INPUT_ID,
    );

    const block = result.draft.blocks.find((candidate) => candidate.type === 'uncertain');
    assert.deepEqual(block, {
      type: 'uncertain',
      items: [
        { text: '存疑2', reason: '原因2' },
        { text: '存疑3', reason: '原因3', resolution: '第三条的更正。' },
      ],
    });
    assert.equal(result.applied, 2);
    assert.deepEqual(result.warnings, []);
  });

  it('多个存疑块：编号是跨块连续的（就是用户看到的编号）', () => {
    const draft: NoteDraft = {
      title: '样本笔记',
      summary: '一句话总结。',
      language: 'zh',
      tags: ['AE'],
      blocks: [
        { type: 'uncertain', items: [{ text: '存疑1', reason: '原因1' }] },
        { type: 'text', text: '中间还有正文。' },
        { type: 'uncertain', items: [{ text: '存疑2', reason: '原因2' }] },
      ],
    };

    const result = applyRulings(
      draft,
      1,
      rulingsOf([{ item_index: 2, text: '存疑2', action: 'drop' }]),
      INPUT_ID,
    );

    assert.deepEqual(result.draft.blocks[0], {
      type: 'uncertain',
      items: [{ text: '存疑1', reason: '原因1' }],
    });
    assert.deepEqual(result.draft.blocks[2], { type: 'uncertain', items: [] });
    assert.equal(result.applied, 1);
  });

  it('item_index 越界：警告 + 这一条按 keep，其余裁定照常应用', () => {
    const draft = draftWithUncertain(2);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([
        { item_index: 1, text: '存疑1', action: 'drop' },
        { item_index: 9, text: '存疑9', action: 'drop' },
      ]),
      INPUT_ID,
    );

    assert.equal(result.applied, 1, '越界那条不算数');
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]?.includes('存疑项 #9'));
    assert.ok(result.warnings[0]?.includes('不存在'));
    assert.ok(result.warnings[0]?.includes('按保留处理'));

    const block = result.draft.blocks.find((candidate) => candidate.type === 'uncertain');
    assert.deepEqual(block, {
      type: 'uncertain',
      items: [{ text: '存疑2', reason: '原因2' }],
    });
  });

  it('text 对不上：警告 + 降级成 keep，绝不硬套到另一条上', () => {
    const draft = draftWithUncertain(2);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([{ item_index: 1, text: '这是另一条存疑项的原文', action: 'drop' }]),
      INPUT_ID,
    );

    assert.equal(result.applied, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]?.includes('对不上'));
    assert.ok(result.warnings[0]?.includes('按保留处理'));

    const block = result.draft.blocks.find((candidate) => candidate.type === 'uncertain');
    assert.deepEqual(block, {
      type: 'uncertain',
      items: [
        { text: '存疑1', reason: '原因1' },
        { text: '存疑2', reason: '原因2' },
      ],
    });
  });

  it('edit 但没写更正内容：警告 + 按 keep', () => {
    const draft = draftWithUncertain(1);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([{ item_index: 1, text: '存疑1', action: 'edit', resolution: '   ' }]),
      INPUT_ID,
    );

    assert.equal(result.applied, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]?.includes('没有写更正内容'));
    assert.deepEqual(result.draft.blocks.find((candidate) => candidate.type === 'uncertain'), {
      type: 'uncertain',
      items: [{ text: '存疑1', reason: '原因1' }],
    });
    assert.deepEqual(result.draft, draft, '降级之后草稿应当逐字段原样');
  });

  it('草稿里一条存疑项都没有：任何裁定都降级成警告，草稿原样', () => {
    const draft = draftWithUncertain(0);
    const result = applyRulings(
      draft,
      1,
      rulingsOf([{ item_index: 1, text: '存疑1', action: 'drop' }]),
      INPUT_ID,
    );

    assert.equal(result.applied, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]?.includes('一共有 0 条存疑项'));
    assert.deepEqual(result.draft, draft);
  });

  it('纯函数：全部裁定都套上时，传进来的草稿依然逐字段原样', () => {
    const draft = draftWithUncertain(1);
    const snapshot = JSON.stringify(draft);

    applyRulings(
      draft,
      1,
      rulingsOf([
        { item_index: 1, text: '存疑1', action: 'drop' },
      ]),
      INPUT_ID,
    );

    assert.equal(JSON.stringify(draft), snapshot, '重放不许就地改调用方的草稿');
  });
});
