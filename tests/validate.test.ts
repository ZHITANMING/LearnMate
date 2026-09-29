/**
 * `core/validate.ts` 的测试。
 *
 * 这个文件的性格是「宁严勿松」，所以测试的重点有两类：
 *   1. **该拦的必须拦住**——尤其是「看起来很正常但会让你做错操作」的那些（换行、
 *      以 `-` 开头伪造出列表、标题重复导致互相覆盖）；
 *   2. **不该拦的绝不能拦**——误判一次就是一次白花的模型调用。所以
 *      `-5 度`、单个花括号、没写的可选字段、将来才加的额外字段，都必须放行。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ValidationProblem } from '../src/core/validate.js';
import { LIMITS, formatProblems, validateAnalyzeResult } from '../src/core/validate.js';

/** 一个怎么都合法的笔记。每个用例只在它身上改一处。 */
function goodNote(): Record<string, unknown> {
  return {
    title: '素材加边缘光（提取 + 乙插件）',
    summary: '先把发光部分抠出来，再让它发光。',
    language: 'zh',
    tags: ['AE', '边缘光'],
    blocks: [
      { type: 'text', text: '注意是在阴影的基础上做。' },
      { type: 'steps', title: '操作步骤', items: ['选中独显图层，加提取。', '再加 乙插件。'] },
      { type: 'params', title: '参数', items: [{ name: '发光半径', value: '100', note: '按需调' }] },
      { type: 'concept', term: '嵌套工程', explanation: '把几个图层打成一个。' },
      { type: 'uncertain', items: [{ text: '通道选明亮度', reason: '原文这里没写清楚' }] },
    ],
  };
}

/** 克隆一份合法笔记，按 `patch` 改掉顶层字段。 */
function noteWith(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...goodNote(), ...patch };
}

function expectPass(value: unknown): void {
  const outcome = validateAnalyzeResult(value);
  if (!outcome.ok) {
    assert.fail(`本来应该通过，却报了这些错：\n${formatProblems(outcome.problems)}`);
  }
}

function expectFail(value: unknown): ValidationProblem[] {
  const outcome = validateAnalyzeResult(value);
  assert.equal(outcome.ok, false, '本来应该被拦下来，却通过了');
  return outcome.ok ? [] : [...outcome.problems];
}

function problemAt(problems: readonly ValidationProblem[], path: string): ValidationProblem {
  const found = problems.find((problem) => problem.path === path);
  assert.ok(
    found !== undefined,
    `没有任何问题指向 ${path}；实际报的是：${problems.map((problem) => problem.path).join('、')}`,
  );
  return found;
}

describe('validateAnalyzeResult：放行的那些', () => {
  it('一个规规矩矩的结果原样通过', () => {
    const outcome = validateAnalyzeResult({ notes: [goodNote()] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.notes.length, 1);
    assert.deepEqual(
      outcome.result.notes[0]?.tags,
      ['AE', '边缘光'],
      '合法数据不该在校验时被改写',
    );
  });

  it('notes 是空数组也通过——「0 条」是契约 4.1 允许的最后手段', () => {
    expectPass({ notes: [] });
  });

  it('language 可以不写，缺省是 zh', () => {
    const note = goodNote();
    delete note['language'];
    const outcome = validateAnalyzeResult({ notes: [note] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.notes[0]?.language, 'zh');
  });

  it('正好卡在长度上限上是通过的', () => {
    expectPass({ notes: [noteWith({ title: '标'.repeat(LIMITS.titleMax) })] });
    expectPass({ notes: [noteWith({ summary: '摘'.repeat(LIMITS.summaryMax) })] });
    expectPass({ notes: [noteWith({ tags: ['标'.repeat(LIMITS.tagMax)] })] });
  });

  it('长度按 Unicode 码点算：80 个 emoji 是 80 个字符，不是 160 个', () => {
    expectPass({ notes: [noteWith({ title: '🎬'.repeat(LIMITS.titleMax) })] });
    const problems = expectFail({ notes: [noteWith({ title: '🎬'.repeat(LIMITS.titleMax + 1) })] });
    assert.match(problemAt(problems, 'notes[0].title').message, /至多 80 个字符，现在有 81 个/);
  });

  it('可选字段不写、或写成空串，都算「没有」', () => {
    expectPass({
      notes: [
        noteWith({
          blocks: [
            { type: 'steps', items: ['一步'] },
            { type: 'list', title: '', items: ['一条'] },
            { type: 'params', items: [{ name: '半径', value: '', note: '' }] },
          ],
        }),
      ],
    });
  });

  it('不认识的额外字段一律忽略——将来给 schema 加字段时不该把新输出全判成非法', () => {
    expectPass({
      notes: [
        noteWith({
          future_field: '将来的字段',
          blocks: [
            { type: 'text', text: '正文。', future_field: 1 },
            { type: 'params', items: [{ name: '半径', future_field: true }] },
          ],
        }),
      ],
    });
  });

  it('正文里出现单个花括号是正常的（JSON 例子），不要误伤', () => {
    expectPass({
      notes: [noteWith({ blocks: [{ type: 'text', text: '输出长这样：{"notes": []}' }] })],
    });
  });

  it('`-5 度` 不算以 Markdown 符号开头——`-` 后面没空白就不像列表', () => {
    expectPass({
      notes: [noteWith({ blocks: [{ type: 'list', items: ['-5 度也能拍', '3.5 倍速'] }] })],
    });
  });
});

describe('validateAnalyzeResult：拦下来的那些', () => {
  it('顶层不是对象', () => {
    const problems = expectFail([]);
    assert.match(problems[0]?.message ?? '', /顶层必须是一个 JSON 对象，现在是 数组/);
  });

  it('没有 notes 或 notes 不是数组', () => {
    assert.match(expectFail({})[0]?.message ?? '', /必须是数组，现在是\s*（没有这个字段）/);
    assert.match(expectFail({ notes: '一条' })[0]?.message ?? '', /现在是 字符串/);
  });

  it('notes 超过 15 条', () => {
    const notes = Array.from({ length: 16 }, (_, index) =>
      noteWith({ title: `第 ${String(index)} 条笔记` }),
    );
    const problems = expectFail({ notes });
    assert.match(problemAt(problems, 'notes').message, /至多 15 条，现在有 16 条/);
  });

  it('title 缺失、空、超长', () => {
    const missing = goodNote();
    delete missing['title'];
    assert.match(problemAt(expectFail({ notes: [missing] }), 'notes[0].title').message, /必须是字符串/);
    assert.match(
      problemAt(expectFail({ notes: [noteWith({ title: '' })] }), 'notes[0].title').message,
      /不能为空/,
    );
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ title: '标'.repeat(LIMITS.titleMax + 1) })] }),
        'notes[0].title',
      ).message,
      /至多 80 个字符/,
    );
  });

  it('字符串里出现换行', () => {
    const problems = expectFail({ notes: [noteWith({ summary: '第一行\n第二行' })] });
    assert.match(problemAt(problems, 'notes[0].summary').message, /不能包含换行/);
  });

  it('字符串以 Markdown 结构符号开头（会伪造出不存在的标题或列表）', () => {
    for (const bad of ['# 大标题', '## 小标题', '- 一条', '* 一条', '+ 一条', '> 引用', '1. 第一步']) {
      const problems = expectFail({
        notes: [noteWith({ blocks: [{ type: 'list', items: [bad] }] })],
      });
      assert.match(
        problemAt(problems, 'notes[0].blocks[0].items[0]').message,
        /不能以 Markdown 结构符号开头/,
        `${JSON.stringify(bad)} 应该被拦下来`,
      );
    }
  });

  it('字符串里有代码围栏或表格行', () => {
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [{ type: 'text', text: '看 ``` 这里' }] })] }),
        'notes[0].blocks[0].text',
      ).message,
      /代码围栏/,
    );
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [{ type: 'text', text: '| 左边 | 右边 |' }] })] }),
        'notes[0].blocks[0].text',
      ).message,
      /表格行/,
    );
  });

  it('language 只认 zh / en', () => {
    const problems = expectFail({ notes: [noteWith({ language: 'fr' })] });
    assert.match(problemAt(problems, 'notes[0].language').message, /只能是 "zh" 或 "en"/);
  });

  it('tags 数量与单项长度', () => {
    assert.match(
      problemAt(expectFail({ notes: [noteWith({ tags: [] })] }), 'notes[0].tags').message,
      /要有 1–5 个标签，现在有 0 个/,
    );
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] })] }),
        'notes[0].tags',
      ).message,
      /要有 1–5 个标签，现在有 6 个/,
    );
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ tags: ['长'.repeat(LIMITS.tagMax + 1)] })] }),
        'notes[0].tags[0]',
      ).message,
      /至多 20 个字符/,
    );
  });

  it('blocks 数量', () => {
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [] })] }),
        'notes[0].blocks',
      ).message,
      /要有 1–12 个块，现在有 0 个/,
    );
    const many = Array.from({ length: 13 }, () => ({ type: 'text', text: '一段话。' }));
    assert.match(
      problemAt(expectFail({ notes: [noteWith({ blocks: many })] }), 'notes[0].blocks').message,
      /要有 1–12 个块，现在有 13 个/,
    );
  });

  it('模型无权发明新的块类型', () => {
    const problems = expectFail({
      notes: [noteWith({ blocks: [{ type: 'table', rows: [] }] })],
    });
    assert.match(problemAt(problems, 'notes[0].blocks[0].type').message, /不认识的块类型 "table"/);
  });

  it('各块的必填字段', () => {
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [{ type: 'text' }] })] }),
        'notes[0].blocks[0].text',
      ).message,
      /必须是字符串/,
    );
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [{ type: 'concept', term: '嵌套工程' }] })] }),
        'notes[0].blocks[0].explanation',
      ).message,
      /必须是字符串/,
    );
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [{ type: 'params', items: [{ value: '100' }] }] })] }),
        'notes[0].blocks[0].items[0].name',
      ).message,
      /必须是字符串/,
    );
  });

  it('steps / list / params / uncertain 的条数', () => {
    assert.match(
      problemAt(
        expectFail({ notes: [noteWith({ blocks: [{ type: 'steps', items: [] }] })] }),
        'notes[0].blocks[0].items',
      ).message,
      /要有 1–15 项，现在有 0 项/,
    );
    assert.match(
      problemAt(
        expectFail({
          notes: [
            noteWith({
              blocks: [
                { type: 'list', items: Array.from({ length: 11 }, (_, i) => `第 ${String(i)} 条`) },
              ],
            }),
          ],
        }),
        'notes[0].blocks[0].items',
      ).message,
      /要有 1–10 项，现在有 11 项/,
    );
    assert.match(
      problemAt(
        expectFail({
          notes: [
            noteWith({
              blocks: [
                {
                  type: 'params',
                  items: Array.from({ length: 16 }, (_, i) => ({ name: `参数${String(i)}` })),
                },
              ],
            }),
          ],
        }),
        'notes[0].blocks[0].items',
      ).message,
      /要有 1–15 项，现在有 16 项/,
    );
  });

  it('一条笔记至多 1 个 uncertain 块', () => {
    const problems = expectFail({
      notes: [
        noteWith({
          blocks: [
            { type: 'uncertain', items: [{ text: '甲', reason: '看不懂' }] },
            { type: 'uncertain', items: [{ text: '乙', reason: '看不懂' }] },
          ],
        }),
      ],
    });
    assert.match(problemAt(problems, 'notes[0].blocks[1]').message, /至多 1 个 uncertain 块/);
  });

  it('uncertain 的每一项都必须说出理由', () => {
    const problems = expectFail({
      notes: [noteWith({ blocks: [{ type: 'uncertain', items: [{ text: '甲' }] }] })],
    });
    assert.match(problemAt(problems, 'notes[0].blocks[0].items[0].reason').message, /必须是字符串/);
  });

  it('标题重复会被拦下来——它们会变成同一个文件名，后写的覆盖先写的', () => {
    const problems = expectFail({
      notes: [
        noteWith({ title: '素材加边缘光' }),
        noteWith({ title: '别的' }),
        noteWith({ title: '素材加边缘光' }),
      ],
    });
    const problem = problemAt(problems, 'notes[2].title');
    assert.match(problem.message, /和 notes\[0\] 的标题一模一样/);
  });

  it('一处都不改也要把问题一次报全', () => {
    const problems = expectFail({
      notes: [noteWith({ title: '', language: 'fr', tags: [], blocks: [] })],
    });
    assert.ok(problems.length >= 4, `应该一次报出至少 4 处，实际 ${String(problems.length)} 处`);
  });
});

describe('formatProblems', () => {
  it('一条一行，带位置', () => {
    const text = formatProblems([
      { path: 'notes[0].title', message: '不能为空' },
      { path: '', message: '顶层不对' },
    ]);
    assert.equal(text, '- notes[0].title：不能为空\n- 顶层不对');
  });

  it('超过上限时写明还剩多少条没列出来，不静默截断', () => {
    const problems = Array.from({ length: 15 }, (_, index) => ({
      path: `notes[${String(index)}].title`,
      message: '不对',
    }));
    const text = formatProblems(problems, 12);
    assert.equal(text.split('\n').length, 13);
    assert.match(text, /还有 3 处没列出来/);
  });
});
