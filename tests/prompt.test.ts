/**
 * `core/prompt.ts` 的测试：提示词怎么组装，以及模板写坏时会不会被拦住。
 * 最后一组顺带测了 `io/prompt.ts` 的读文件（读不到 / 带 BOM 这两种真实情况）。
 *
 * 最要紧的一条是「坏模板必须报错，而不是把半成品发给模型」——
 * 模型收到看不懂的记号**不会报错**，它会猜，然后泰然自若地给出一份
 * 标签一个都没复用词表的结果。一个笔误就这样静默地变成了提示词的一部分。
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError } from '../src/core/errors.js';
import {
  EMPTY_VOCABULARY,
  TAG_VOCABULARY_PLACEHOLDER,
  assembleSystemMessage,
  assertPromptTemplate,
  renderTagVocabulary,
} from '../src/core/prompt.js';
import { readPromptTemplate } from '../src/io/prompt.js';

/** 从本文件往上找，直到找到仓库里的某个文件。源码直跑和编译后跑（dist-test/）都能用。 */
function findRepoFile(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`从 ${import.meta.url} 往上找不到 ${relativePath}`);
}

const GOOD_TEMPLATE =
  `你是录入员，只输出 JSON。\n\n已有标签词表：\n${TAG_VOCABULARY_PLACEHOLDER}\n\n开始吧。`;

describe('renderTagVocabulary', () => {
  it('一个标签都没有时给一句说明，而不是留一片空白', () => {
    assert.equal(renderTagVocabulary([]), EMPTY_VOCABULARY);
    assert.equal(renderTagVocabulary(['', '   ']), EMPTY_VOCABULARY);
  });

  it('一行一个标签，前面加 "- "', () => {
    assert.equal(renderTagVocabulary(['AE']), '- AE');
    assert.equal(renderTagVocabulary(['AE', 'AN']), '- AE\n- AN');
  });

  it('去重、去空白并排序，让同样的标签集永远得到逐字符相同的文字', () => {
    assert.equal(renderTagVocabulary(['位移', 'AE', 'AE', ' AN ']), '- AE\n- AN\n- 位移');
    assert.equal(
      renderTagVocabulary(['AE', 'AN']),
      renderTagVocabulary(['AN', 'AE', 'AE']),
      '输入顺序不该影响结果',
    );
  });

  it('超过 200 个时截住，并写明还有多少个没列出来', () => {
    const tags = Array.from({ length: 205 }, (_, index) => `t${String(index).padStart(3, '0')}`);
    const lines = renderTagVocabulary(tags).split('\n');
    assert.equal(lines.length, 201, '200 行标签 + 1 行说明');
    assert.equal(lines[200], '（词表里还有 5 个标签没列出来。）');
  });
});

describe('assertPromptTemplate', () => {
  it('正常模板通过', () => {
    assert.doesNotThrow(() => {
      assertPromptTemplate(GOOD_TEMPLATE);
    });
  });

  it('真正的提示词文件通过——它跟着代码一起发布，不能是坏的', () => {
    const file = findRepoFile(join('prompts', 'analyze.v1.md'));
    assert.doesNotThrow(() => {
      assertPromptTemplate(readFileSync(file, 'utf8'));
    });
  });

  it('空文件被拦下来', () => {
    assert.throws(
      () => {
        assertPromptTemplate('   \n  ');
      },
      (error: unknown) => {
        assert.ok(error instanceof UsageError, '应该是 UsageError');
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.match(error.message, /文件是空的/);
        return true;
      },
    );
  });

  it('没有占位符被拦下来', () => {
    assert.throws(() => {
      assertPromptTemplate('你是录入员，只输出 JSON。');
    }, /找不到占位符/);
  });

  it('占位符出现两次被拦下来', () => {
    assert.throws(() => {
      assertPromptTemplate(`${TAG_VOCABULARY_PLACEHOLDER}\n${TAG_VOCABULARY_PLACEHOLDER}`);
    }, /出现了 2 次/);
  });

  it('别的 {{...}} 占位符被拦下来——模型看不懂它，但它会照做', () => {
    assert.throws(() => {
      assertPromptTemplate(`${TAG_VOCABULARY_PLACEHOLDER}\n{{SOMETHING_ELSE}}`);
    }, /不认识的占位符/);
  });

  it('不成对的 {{ 或 }} 被拦下来，并指出在第几行', () => {
    assert.throws(() => {
      assertPromptTemplate(`${TAG_VOCABULARY_PLACEHOLDER}\n第二行没事\n第三行有个 {{ 少了一半`);
    }, /第 3 行[\s\S]*不成对/);

    assert.throws(() => {
      assertPromptTemplate(`${TAG_VOCABULARY_PLACEHOLDER}\n多了一个 }}`);
    }, /第 2 行[\s\S]*不成对/);
  });

  it('正文里的单个花括号是正常的（JSON 例子要用），不要误伤', () => {
    assert.doesNotThrow(() => {
      assertPromptTemplate(
        `${TAG_VOCABULARY_PLACEHOLDER}\n\n输出长这样：\n{"notes": [{"title": "x"}]}`,
      );
    });
  });

  it('一次把问题全说出来，不要报一个修一个', () => {
    assert.throws(
      () => {
        assertPromptTemplate('{{A}}\n{{B}}');
      },
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /找不到占位符/);
        assert.match(error.message, /\{\{A\}\}/);
        assert.match(error.message, /\{\{B\}\}/);
        assert.match(error.message, /有 2 处问题/);
        return true;
      },
    );
  });
});

describe('assembleSystemMessage', () => {
  it('把占位符换成真实词表，并且一个 {{ 都不剩', () => {
    const text = assembleSystemMessage(GOOD_TEMPLATE, ['AE', '位移']);
    assert.ok(text.includes('- AE\n- 位移'));
    assert.ok(!text.includes(TAG_VOCABULARY_PLACEHOLDER));
    assert.ok(!text.includes('{{'));
  });

  it('没有标签时也把占位符换掉，绝不留下裸露的 {{TAG_VOCABULARY}}', () => {
    const text = assembleSystemMessage(GOOD_TEMPLATE, []);
    assert.ok(text.includes(EMPTY_VOCABULARY));
    assert.ok(!text.includes('{{'));
  });

  it('同样的模板 + 同样的标签 = 逐字符相同的系统消息', () => {
    const first = assembleSystemMessage(GOOD_TEMPLATE, ['AE', 'AN', '位移']);
    const second = assembleSystemMessage(GOOD_TEMPLATE, ['位移', 'AN', 'AE']);
    assert.equal(first, second);
  });

  for (const version of ['analyze.v1', 'analyze.v2'] as const) {
    it(`用真正的提示词文件组装：标签清单落在第七节（${version}）`, () => {
      const template = readFileSync(findRepoFile(join('prompts', `${version}.md`)), 'utf8');
      const text = assembleSystemMessage(template, ['AE', '甲脚本']);
      assert.ok(text.includes('- AE\n- 甲脚本'));
      assert.ok(!text.includes('{{'));
      assert.ok(text.includes('## 七、标签'));
    });
  }

  it('模板坏了就抛 UsageError，不返回半成品', () => {
    assert.throws(
      () => assembleSystemMessage('没有占位符', ['AE']),
      (error: unknown) => error instanceof UsageError && error.exitCode === EXIT.USAGE,
    );
  });
});

describe('readPromptTemplate', () => {
  for (const version of ['analyze.v1', 'analyze.v2'] as const) {
    it(`读出来的和磁盘上的内容逐字符一致（${version}）`, () => {
      const file = findRepoFile(join('prompts', `${version}.md`));
      assert.equal(readPromptTemplate(file, version), readFileSync(file, 'utf8'));
    });
  }

  it('文件不在时抛 UsageError，并提醒去查 promptVersion', () => {
    assert.throws(
      () => readPromptTemplate(join(tmpdir(), 'learnmate-没有这个目录', 'analyze.v9.md'), 'analyze.v9'),
      (error: unknown) => {
        assert.ok(error instanceof UsageError, '应该是 UsageError（退出码 2，此时还没写任何东西）');
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.match(error.message, /找不到提示词文件/);
        assert.match(error.message, /analyze\.v9/);
        assert.match(error.message, /promptVersion/);
        return true;
      },
    );
  });

  it('开头的 BOM 会被去掉——记事本会写它，它会变成提示词的第一个字符', () => {
    const dir = mkdtempSync(join(tmpdir(), 'learnmate-prompt-'));
    const file = join(dir, 'bom.md');
    writeFileSync(file, `\uFEFF${TAG_VOCABULARY_PLACEHOLDER}\n`);
    try {
      assert.equal(readPromptTemplate(file, 'bom'), `${TAG_VOCABULARY_PLACEHOLDER}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
