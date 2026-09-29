// 提示词文件本身的守卫。
//
// 提示词的正确性没法自动化验证——「拆出来的笔记对不对」只能拿真实笔记跑一遍才知道。
// 但它有一条性质是机器能查的，而且这条性质很重要：
//
//   **提示词里那个例子，本身必须是一个合法的 AnalyzeResult。**
//
// 因为模型是会照着例子学的。例子跑偏一点，模型就跟着跑偏一片。这个测试就是钉住例子。

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * 提示词是仓库根的**内容文件**，不是编译产物。
 * 但测试跑的是 `dist-test/tests/*.js`（见 package.json 的 test 脚本），
 * 所以不能写死 `../prompts/`——从测试文件所在目录往上找，谁先找到算谁的。
 * 好处是源码直跑（`tests/`）与编译后跑（`dist-test/tests/`）都对。
 */
function findPromptFile(startDir: string, version: string): string {
  let dir = startDir;
  for (let hops = 0; hops < 6; hops += 1) {
    const candidate = join(dir, 'prompts', `analyze.${version}.md`);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到 prompts/analyze.${version}.md：从 ${startDir} 往上找了 6 层都没有。`);
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 每一个已发布的提示词版本都要过同一套守卫，一个都不能少。
 * v1 保留不删——已经落盘的笔记 frontmatter 里写着 `prompt_version: analyze.v1`，
 * 那个版本必须永远可解释（决策 D23）。
 */
const PROMPT_VERSIONS = ['v1', 'v2'] as const;

export const PROMPT_PATH = findPromptFile(HERE, 'v1');

/** 抓出提示词里所有 ```json 围栏里的内容。 */
function jsonFences(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json\r?\n([\s\S]*?)```/g;
  let match = pattern.exec(markdown);
  while (match !== null) {
    blocks.push(match[1] ?? '');
    match = pattern.exec(markdown);
  }
  return blocks;
}

/**
 * 契约第 4.4 节：所有字符串值都必须是单行纯文本，且不能以 Markdown 结构符号开头。
 * 这条如果破了，渲染出来的正文会凭空多出标题或列表。
 */
function assertCleanString(value: unknown, max: number, field: string, allowEmpty = false): void {
  assert.equal(typeof value, 'string', `${field} 必须是字符串`);
  const text = value as string;
  assert.ok(
    allowEmpty ? text.length <= max : text.length >= 1 && text.length <= max,
    `${field} 长度应在 ${allowEmpty ? '0' : '1'}–${max} 之间，实际 ${text.length}：${JSON.stringify(text)}`,
  );
  assert.ok(!/[\r\n]/.test(text), `${field} 不能包含换行：${JSON.stringify(text)}`);
  assert.ok(
    !/^[#\-*>]/.test(text) && !/^\d+\./.test(text),
    `${field} 不能以 Markdown 结构符号开头：${JSON.stringify(text)}`,
  );
}

// 契约第 4.3 节的长度约束，就地抄一份。
// 故意不从这里导出复用——T9 会有一份真正的运行期校验器，这份只服务于「钉住例子」。
const TEXT_MAX = 500;
const STEPS_ITEM_MAX = 300;
const STEPS_MAX_ITEMS = 15;
const LIST_ITEM_MAX = 200;
const LIST_MAX_ITEMS = 10;
const PARAM_NAME_MAX = 40;
const PARAM_VALUE_MAX = 40;
const PARAM_NOTE_MAX = 200;
const PARAM_MAX_ITEMS = 15;
const CONCEPT_TERM_MAX = 40;
const CONCEPT_EXPLANATION_MAX = 300;
const UNCERTAIN_TEXT_MAX = 300;
const UNCERTAIN_REASON_MAX = 200;
const UNCERTAIN_MAX_ITEMS = 10;
const BLOCK_TITLE_MAX = 40;

function assertBlock(block: unknown, where: string): string {
  assert.ok(block !== null && typeof block === 'object', `${where} 必须是对象`);
  const b = block as Record<string, unknown>;
  const type = b['type'];
  assert.equal(typeof type, 'string', `${where}.type 必须是字符串`);

  switch (type) {
    case 'text':
      assertCleanString(b['text'], TEXT_MAX, `${where}.text`);
      break;

    case 'steps': {
      if (b['title'] !== undefined) assertCleanString(b['title'], BLOCK_TITLE_MAX, `${where}.title`, true);
      const items = b['items'];
      assert.ok(Array.isArray(items), `${where}.items 必须是数组`);
      assert.ok(
        items.length >= 1 && items.length <= STEPS_MAX_ITEMS,
        `${where}.items 应有 1–${STEPS_MAX_ITEMS} 项，实际 ${items.length}`,
      );
      items.forEach((item, i) => assertCleanString(item, STEPS_ITEM_MAX, `${where}.items[${i}]`));
      break;
    }

    case 'list': {
      if (b['title'] !== undefined) assertCleanString(b['title'], BLOCK_TITLE_MAX, `${where}.title`, true);
      const items = b['items'];
      assert.ok(Array.isArray(items), `${where}.items 必须是数组`);
      assert.ok(
        items.length >= 1 && items.length <= LIST_MAX_ITEMS,
        `${where}.items 应有 1–${LIST_MAX_ITEMS} 项，实际 ${items.length}`,
      );
      items.forEach((item, i) => assertCleanString(item, LIST_ITEM_MAX, `${where}.items[${i}]`));
      break;
    }

    case 'params': {
      if (b['title'] !== undefined) assertCleanString(b['title'], BLOCK_TITLE_MAX, `${where}.title`, true);
      const items = b['items'];
      assert.ok(Array.isArray(items), `${where}.items 必须是数组`);
      assert.ok(
        items.length >= 1 && items.length <= PARAM_MAX_ITEMS,
        `${where}.items 应有 1–${PARAM_MAX_ITEMS} 项，实际 ${items.length}`,
      );
      items.forEach((item, i) => {
        const p = item as Record<string, unknown>;
        assertCleanString(p['name'], PARAM_NAME_MAX, `${where}.items[${i}].name`);
        if (p['value'] !== undefined) {
          assertCleanString(p['value'], PARAM_VALUE_MAX, `${where}.items[${i}].value`, true);
        }
        if (p['note'] !== undefined) {
          assertCleanString(p['note'], PARAM_NOTE_MAX, `${where}.items[${i}].note`, true);
        }
      });
      break;
    }

    case 'concept':
      assertCleanString(b['term'], CONCEPT_TERM_MAX, `${where}.term`);
      assertCleanString(b['explanation'], CONCEPT_EXPLANATION_MAX, `${where}.explanation`);
      break;

    case 'uncertain': {
      const items = b['items'];
      assert.ok(Array.isArray(items), `${where}.items 必须是数组`);
      assert.ok(
        items.length >= 1 && items.length <= UNCERTAIN_MAX_ITEMS,
        `${where}.items 应有 1–${UNCERTAIN_MAX_ITEMS} 项，实际 ${items.length}`,
      );
      items.forEach((item, i) => {
        const u = item as Record<string, unknown>;
        assertCleanString(u['text'], UNCERTAIN_TEXT_MAX, `${where}.items[${i}].text`);
        assertCleanString(u['reason'], UNCERTAIN_REASON_MAX, `${where}.items[${i}].reason`);
      });
      break;
    }

    default:
      assert.fail(`${where} 里有未知的块类型：${JSON.stringify(type)}`);
  }

  return type as string;
}

/** 契约第 4.1 / 4.2 节：顶层结构 + NoteDraft 的字段约束。 */
function assertAnalyzeResult(value: unknown): void {
  assert.ok(value !== null && typeof value === 'object', '顶层必须是对象');
  const notes = (value as Record<string, unknown>)['notes'];
  assert.ok(Array.isArray(notes), 'notes 必须是数组');
  // 契约 4.1：0–15 条。0 条是窄口子，但它是合法的，所以这里下界是 0。
  assert.ok(notes.length <= 15, `notes 至多 15 条，实际 ${notes.length}`);

  const titles = new Set<string>();

  notes.forEach((note, i) => {
    const where = `notes[${i}]`;
    assert.ok(note !== null && typeof note === 'object', `${where} 必须是对象`);
    const n = note as Record<string, unknown>;

    assertCleanString(n['title'], 80, `${where}.title`);
    assertCleanString(n['summary'], 300, `${where}.summary`);

    // 契约第 4.5 节第 7 条：同一次输出里不能有两条标题相同的笔记（TD8 的防线之一）。
    const title = n['title'] as string;
    assert.ok(!titles.has(title), `${where}.title 与前面的笔记重复：${JSON.stringify(title)}`);
    titles.add(title);

    assert.ok(n['language'] === 'zh' || n['language'] === 'en', `${where}.language 只能是 zh 或 en`);

    const tags = n['tags'];
    assert.ok(Array.isArray(tags), `${where}.tags 必须是数组`);
    assert.ok(tags.length >= 1 && tags.length <= 5, `${where}.tags 应有 1–5 项，实际 ${tags.length}`);
    tags.forEach((tag, j) => assertCleanString(tag, 20, `${where}.tags[${j}]`));

    const blocks = n['blocks'];
    assert.ok(Array.isArray(blocks), `${where}.blocks 必须是数组`);
    assert.ok(blocks.length >= 1 && blocks.length <= 12, `${where}.blocks 应有 1–12 个，实际 ${blocks.length}`);

    const types = blocks.map((block, j) => assertBlock(block, `${where}.blocks[${j}]`));

    // 契约第 4.3 节：每条笔记至多 1 个 uncertain 块。
    const uncertainCount = types.filter((t) => t === 'uncertain').length;
    assert.ok(uncertainCount <= 1, `${where} 有 ${uncertainCount} 个 uncertain 块，至多只能有 1 个`);
    // 提示词第 3.6 节要求它放在最后（渲染器其实会把它收拢到文末，但例子要带头示范）。
    if (uncertainCount === 1) {
      assert.equal(types[types.length - 1], 'uncertain', `${where} 的 uncertain 块应该放在最后`);
    }
  });
}

for (const version of PROMPT_VERSIONS) {
  const prompt = readFileSync(findPromptFile(HERE, version), 'utf8');

  describe(`prompts/analyze.${version}.md`, () => {
    it('文件存在、内容不为空、以 UTF-8 读得出来', () => {
      assert.ok(prompt.length > 1000, `提示词只有 ${prompt.length} 字符，是不是被清空了？`);
    });

    it('整个文件里有且只有一个 {{TAG_VOCABULARY}} 占位符', () => {
      const count = prompt.split('{{TAG_VOCABULARY}}').length - 1;
      assert.equal(count, 1, `{{TAG_VOCABULARY}} 出现了 ${count} 次，必须恰好 1 次`);
    });

    it('没有别的 {{...}} 占位符（契约 4.7：未知占位符必须报错）', () => {
      const found = prompt.match(/\{\{[^}]*\}\}/g) ?? [];
      const unknown = found.filter((token) => token !== '{{TAG_VOCABULARY}}');
      assert.deepEqual(unknown, [], `出现了未知占位符：${unknown.join('、')}`);
    });

    it('花括号是配对的（不配对的 {{ 或 }} 会被组装时报错）', () => {
      const opens = prompt.split('{{').length - 1;
      const closes = prompt.split('}}').length - 1;
      assert.equal(opens, closes, `{{ 出现 ${opens} 次，}} 出现 ${closes} 次`);
    });

    it('六种块类型都讲到了', () => {
      for (const type of ['text', 'steps', 'list', 'params', 'concept', 'uncertain']) {
        assert.ok(prompt.includes(`"type": "${type}"`), `提示词里没提到块类型 ${type}`);
      }
    });

    it('讲清了「技术细节逐字保留」和「拿不准进 uncertain」', () => {
      assert.ok(prompt.includes('逐字保留'), '缺「技术细节逐字保留」这条最重要的内容准则');
      assert.ok(prompt.includes('不要猜'), '缺「拿不准的不要猜」这条');
      assert.ok(/不新增/.test(prompt), '缺「不新增原文没有的事实」这条');
    });

    it('把「0 条」限定成最后手段，而不是模型的退路（契约 4.1）', () => {
      assert.ok(/返回 0 条是最后手段/.test(prompt), '没讲「返回 0 条是最后手段」');
      assert.ok(/返回 0 条的理由/.test(prompt), '没堵住「难懂就返回空」这条退路');
      assert.ok(/难懂的内容应该进/.test(prompt), '没告诉模型难懂的内容该去哪儿');
    });

    it('例子是一个合法的 AnalyzeResult', () => {
      const fences = jsonFences(prompt);
      assert.ok(fences.length > 0, '提示词里找不到任何 ```json 例子');

      const last = fences[fences.length - 1] ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(last);
      } catch (error) {
        assert.fail(`最后一段 json 例子不是合法 JSON：${(error as Error).message}`);
      }

      assertAnalyzeResult(parsed);
    });

    it('例子里至少示范了两条笔记（「通用操作」与「具体效果」要分开）', () => {
      const fences = jsonFences(prompt);
      const parsed = JSON.parse(fences[fences.length - 1] ?? '') as { notes: unknown[] };
      assert.ok(parsed.notes.length >= 2, '例子只示范了一条笔记，讲不清「拆成多条」这件事');
    });

    it('保留了「## 七、标签」这一节（组装器要靠它认出标签词表的位置）', () => {
      assert.ok(prompt.includes('## 七、标签'), '第七节的标题被改了，标签词表就没有稳定的落点');
    });
  });
}

describe('提示词版本的守卫', () => {
  it('每个版本都讲到了粒度下限，不能只靠「不新增/不丢弃」两个约束', () => {
    for (const version of PROMPT_VERSIONS) {
      const prompt = readFileSync(findPromptFile(HERE, version), 'utf8');
      // v1 是历史文件，粒度规则是 v2 才补上的——所以只对 v2 之后施压。
      if (version === 'v1') continue;
      assert.ok(/拆得太碎/.test(prompt), `${version} 没讲「拆得太碎」这件事`);
      assert.ok(/同一主题的多种做法/.test(prompt), `${version} 没讲「同主题的多种做法要合并」`);
      assert.ok(/一个完整流程/.test(prompt), `${version} 没讲「流程要装进一条笔记」`);
      assert.ok(/是索引，不是正文的预告片/.test(prompt), `${version} 没讲「summary 不许抄正文」`);
    }
  });
});
