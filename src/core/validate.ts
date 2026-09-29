/**
 * `AnalyzeResult` 的运行期校验（契约第 4.2–4.4 节）。
 *
 * 模型返回的东西在 TypeScript 眼里是 `unknown` —— 类型断言只会让编译器闭嘴，
 * 不会让数据变干净。这个文件是那道真正的门：**只有通过它，数据才被允许往下走。**
 *
 * 三条设计决定：
 *
 * 1. **一次报全，不报第一个就停。** 重试一次是真的要花钱的，所以要把「上一次错在哪」
 *    尽可能完整地回喂给模型，而不是让它一次改一个。
 * 2. **只做契约写明的事。** 校验器比契约更严是个陷阱：那些被误判的输出在契约上完全合法，
 *    每次误判都要多花一次调用。所以**不认识的额外字段一律忽略**（将来给 schema 加字段时
 *    旧的校验器也不会把新输出全判成非法）。
 * 3. **长度按 Unicode 码点算，不按 UTF-16 码元。** 契约说的是「字符」，
 *    而 `.length` 会把一个 emoji 数成两个。`src/util/slug.ts` 截断时也是按码点，两边口径一致。
 *
 * 本文件属于 core：纯函数，不碰文件、网络、时间、随机数。
 */

import type { AnalyzeResult, Block, NoteDraft, ParamItem, UncertainItem } from './contracts.js';

/** 出问题的位置，例如 `notes[2].blocks[1].items[3].text`。 */
export interface ValidationProblem {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly result: AnalyzeResult }
  | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

/** 契约里的全部长度与数量约束，集中在这里，别的文件不要再抄一份。 */
export const LIMITS = {
  notesMin: 0,
  notesMax: 15,
  titleMax: 80,
  summaryMax: 300,
  tagsMin: 1,
  tagsMax: 5,
  tagMax: 20,
  blocksMin: 1,
  blocksMax: 12,
  blockTitleMax: 40,
  textMax: 500,
  stepsItemsMin: 1,
  stepsItemsMax: 15,
  stepsItemMax: 300,
  listItemsMin: 1,
  listItemsMax: 10,
  listItemMax: 200,
  paramsItemsMin: 1,
  paramsItemsMax: 15,
  paramNameMax: 40,
  paramValueMax: 40,
  paramNoteMax: 200,
  conceptTermMax: 40,
  conceptExplanationMax: 300,
  uncertainItemsMin: 1,
  uncertainItemsMax: 10,
  uncertainTextMax: 300,
  uncertainReasonMax: 200,
  uncertainBlocksMaxPerNote: 1,
} as const;

const BLOCK_TYPES = ['text', 'steps', 'list', 'params', 'concept', 'uncertain'] as const;

/**
 * 禁止以 Markdown 结构符号开头（契约 4.4）。
 * 只认「真的会长成一个结构」的写法：`-` 后面必须有空白，
 * 所以 `-5 度` 这种正文不会被误伤。
 */
const STRUCTURAL_START = /^(?:#{1,6}\s|[-*+]\s|>\s?|\d+[.)]\s)/;

/** 代码块围栏。 */
const CODE_FENCE = /```/;

/** 表格：一整行以 `|` 开头或结尾。 */
const TABLE_ROW = /^\||\|\s*$/;

/** 校验整个分析结果。 */
export function validateAnalyzeResult(value: unknown): ValidationResult {
  const checker = new Checker();

  if (!isPlainObject(value)) {
    checker.problem('', `顶层必须是一个 JSON 对象，现在是 ${describeType(value)}`);
    return { ok: false, problems: checker.problems };
  }

  const rawNotes = value['notes'];
  if (!Array.isArray(rawNotes)) {
    checker.problem('notes', `必须是数组，现在是 ${describeType(rawNotes)}`);
    return { ok: false, problems: checker.problems };
  }
  if (rawNotes.length > LIMITS.notesMax) {
    checker.problem(
      'notes',
      `至多 ${LIMITS.notesMax} 条，现在有 ${rawNotes.length} 条。请合并或删减到 ${LIMITS.notesMax} 条以内。`,
    );
  }

  const notes: NoteDraft[] = [];
  const seenTitles = new Map<string, number>();

  rawNotes.forEach((rawNote, index) => {
    const note = checkNote(checker, rawNote, `notes[${index}]`);
    if (note === undefined) return;

    // 契约 4.5 第 8 条。标题相同 → 文件名相同 → 后写的静默覆盖先写的，
    // 正是「内容被弄丢」这一类失败。
    const previous = seenTitles.get(note.title);
    if (previous !== undefined) {
      checker.problem(
        `notes[${index}].title`,
        `和 notes[${previous}] 的标题一模一样（${JSON.stringify(note.title)}）。` +
          `标题会变成文件名，两条同名的会互相覆盖，所以必须改掉其中一个。`,
      );
    } else {
      seenTitles.set(note.title, index);
    }

    notes.push(note);
  });

  if (checker.problems.length > 0) {
    return { ok: false, problems: checker.problems };
  }
  return { ok: true, result: { notes } };
}

/**
 * 把问题列表拼成一段能直接回喂给模型的文字。
 * 超出 `max` 条时明确写出还剩多少条，不静默截断。
 */
export function formatProblems(problems: readonly ValidationProblem[], max = 12): string {
  const shown = problems.slice(0, max);
  const lines = shown.map((problem) =>
    problem.path === '' ? `- ${problem.message}` : `- ${problem.path}：${problem.message}`,
  );
  if (problems.length > shown.length) {
    lines.push(`- （还有 ${problems.length - shown.length} 处没列出来，也请一并改掉。）`);
  }
  return lines.join('\n');
}

// ————————————————————————————— 内部实现 —————————————————————————————

class Checker {
  readonly problems: ValidationProblem[] = [];

  problem(path: string, message: string): void {
    this.problems.push({ path, message });
  }
}

function checkNote(checker: Checker, value: unknown, path: string): NoteDraft | undefined {
  if (!isPlainObject(value)) {
    checker.problem(path, `必须是对象，现在是 ${describeType(value)}`);
    return undefined;
  }

  const title = checkText(checker, `${path}.title`, value['title'], {
    min: 1,
    max: LIMITS.titleMax,
  });
  const summary = checkText(checker, `${path}.summary`, value['summary'], {
    min: 1,
    max: LIMITS.summaryMax,
  });

  const language = checkLanguage(checker, `${path}.language`, value['language']);
  const tags = checkTags(checker, `${path}.tags`, value['tags']);
  const blocks = checkBlocks(checker, `${path}.blocks`, value['blocks']);

  if (title === undefined || summary === undefined || tags === undefined || blocks === undefined) {
    return undefined;
  }
  return { title, summary, language, tags, blocks };
}

function checkLanguage(
  checker: Checker,
  path: string,
  value: unknown,
): 'zh' | 'en' {
  // 契约 4.2：可省略，缺省 zh。
  if (value === undefined) return 'zh';
  if (value === 'zh' || value === 'en') return value;
  checker.problem(path, `只能是 "zh" 或 "en"，现在是 ${JSON.stringify(value)}`);
  return 'zh';
}

function checkTags(checker: Checker, path: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    checker.problem(path, `必须是数组，现在是 ${describeType(value)}`);
    return undefined;
  }
  if (value.length < LIMITS.tagsMin || value.length > LIMITS.tagsMax) {
    checker.problem(
      path,
      `要有 ${LIMITS.tagsMin}–${LIMITS.tagsMax} 个标签，现在有 ${value.length} 个`,
    );
  }

  const tags: string[] = [];
  value.forEach((rawTag, index) => {
    const tag = checkText(checker, `${path}[${index}]`, rawTag, { min: 1, max: LIMITS.tagMax });
    if (tag !== undefined) tags.push(tag);
  });

  return tags.length === value.length ? tags : undefined;
}

function checkBlocks(checker: Checker, path: string, value: unknown): Block[] | undefined {
  if (!Array.isArray(value)) {
    checker.problem(path, `必须是数组，现在是 ${describeType(value)}`);
    return undefined;
  }
  if (value.length < LIMITS.blocksMin || value.length > LIMITS.blocksMax) {
    checker.problem(
      path,
      `要有 ${LIMITS.blocksMin}–${LIMITS.blocksMax} 个块，现在有 ${value.length} 个`,
    );
  }

  const blocks: Block[] = [];
  let uncertainCount = 0;

  value.forEach((rawBlock, index) => {
    const blockPath = `${path}[${index}]`;
    const block = checkBlock(checker, rawBlock, blockPath);
    if (block === undefined) return;

    if (block.type === 'uncertain') {
      uncertainCount += 1;
      if (uncertainCount > LIMITS.uncertainBlocksMaxPerNote) {
        checker.problem(
          blockPath,
          `一条笔记至多 1 个 uncertain 块，这是第 ${uncertainCount} 个。` +
            `请把它们并成一个块的 items。`,
        );
      }
    }
    blocks.push(block);
  });

  return blocks.length === value.length ? blocks : undefined;
}

function checkBlock(checker: Checker, value: unknown, path: string): Block | undefined {
  if (!isPlainObject(value)) {
    checker.problem(path, `必须是对象，现在是 ${describeType(value)}`);
    return undefined;
  }

  const type = value['type'];
  if (typeof type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(type)) {
    checker.problem(
      `${path}.type`,
      `不认识的块类型 ${JSON.stringify(type)}。只允许：${BLOCK_TYPES.join(' / ')}`,
    );
    return undefined;
  }

  switch (type) {
    case 'text': {
      const text = checkText(checker, `${path}.text`, value['text'], {
        min: 1,
        max: LIMITS.textMax,
      });
      return text === undefined ? undefined : { type: 'text', text };
    }
    case 'steps': {
      const title = checkOptionalText(checker, `${path}.title`, value['title'], LIMITS.blockTitleMax);
      const items = checkItems(checker, `${path}.items`, value['items'], {
        min: LIMITS.stepsItemsMin,
        max: LIMITS.stepsItemsMax,
        itemMax: LIMITS.stepsItemMax,
      });
      if (items === undefined) return undefined;
      return title === undefined ? { type: 'steps', items } : { type: 'steps', title, items };
    }
    case 'list': {
      const title = checkOptionalText(checker, `${path}.title`, value['title'], LIMITS.blockTitleMax);
      const items = checkItems(checker, `${path}.items`, value['items'], {
        min: LIMITS.listItemsMin,
        max: LIMITS.listItemsMax,
        itemMax: LIMITS.listItemMax,
      });
      if (items === undefined) return undefined;
      return title === undefined ? { type: 'list', items } : { type: 'list', title, items };
    }
    case 'params': {
      const title = checkOptionalText(checker, `${path}.title`, value['title'], LIMITS.blockTitleMax);
      const items = checkParamItems(checker, `${path}.items`, value['items']);
      if (items === undefined) return undefined;
      return title === undefined ? { type: 'params', items } : { type: 'params', title, items };
    }
    case 'concept': {
      const term = checkText(checker, `${path}.term`, value['term'], {
        min: 1,
        max: LIMITS.conceptTermMax,
      });
      const explanation = checkText(checker, `${path}.explanation`, value['explanation'], {
        min: 1,
        max: LIMITS.conceptExplanationMax,
      });
      if (term === undefined || explanation === undefined) return undefined;
      return { type: 'concept', term, explanation };
    }
    case 'uncertain': {
      const items = checkUncertainItems(checker, `${path}.items`, value['items']);
      return items === undefined ? undefined : { type: 'uncertain', items };
    }
    /* c8 ignore next 2 -- 上面的 includes 已经挡住了别的值 */
    default:
      return undefined;
  }
}

function checkItems(
  checker: Checker,
  path: string,
  value: unknown,
  options: { min: number; max: number; itemMax: number },
): string[] | undefined {
  if (!Array.isArray(value)) {
    checker.problem(path, `必须是数组，现在是 ${describeType(value)}`);
    return undefined;
  }
  if (value.length < options.min || value.length > options.max) {
    checker.problem(
      path,
      `要有 ${options.min}–${options.max} 项，现在有 ${value.length} 项`,
    );
  }

  const items: string[] = [];
  value.forEach((rawItem, index) => {
    const item = checkText(checker, `${path}[${index}]`, rawItem, {
      min: 1,
      max: options.itemMax,
    });
    if (item !== undefined) items.push(item);
  });

  return items.length === value.length ? items : undefined;
}

function checkParamItems(
  checker: Checker,
  path: string,
  value: unknown,
): ParamItem[] | undefined {
  if (!Array.isArray(value)) {
    checker.problem(path, `必须是数组，现在是 ${describeType(value)}`);
    return undefined;
  }
  if (value.length < LIMITS.paramsItemsMin || value.length > LIMITS.paramsItemsMax) {
    checker.problem(
      path,
      `要有 ${LIMITS.paramsItemsMin}–${LIMITS.paramsItemsMax} 项，现在有 ${value.length} 项`,
    );
  }

  const items: ParamItem[] = [];
  value.forEach((rawItem, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(rawItem)) {
      checker.problem(itemPath, `必须是对象，现在是 ${describeType(rawItem)}`);
      return;
    }
    const name = checkText(checker, `${itemPath}.name`, rawItem['name'], {
      min: 1,
      max: LIMITS.paramNameMax,
    });
    const itemValue = checkOptionalText(
      checker,
      `${itemPath}.value`,
      rawItem['value'],
      LIMITS.paramValueMax,
    );
    const note = checkOptionalText(
      checker,
      `${itemPath}.note`,
      rawItem['note'],
      LIMITS.paramNoteMax,
    );
    if (name === undefined) return;

    const param: ParamItem = { name };
    if (itemValue !== undefined) param.value = itemValue;
    if (note !== undefined) param.note = note;
    items.push(param);
  });

  return items.length === value.length ? items : undefined;
}

function checkUncertainItems(
  checker: Checker,
  path: string,
  value: unknown,
): UncertainItem[] | undefined {
  if (!Array.isArray(value)) {
    checker.problem(path, `必须是数组，现在是 ${describeType(value)}`);
    return undefined;
  }
  if (value.length < LIMITS.uncertainItemsMin || value.length > LIMITS.uncertainItemsMax) {
    checker.problem(
      path,
      `要有 ${LIMITS.uncertainItemsMin}–${LIMITS.uncertainItemsMax} 项，现在有 ${value.length} 项`,
    );
  }

  const items: UncertainItem[] = [];
  value.forEach((rawItem, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(rawItem)) {
      checker.problem(itemPath, `必须是对象，现在是 ${describeType(rawItem)}`);
      return;
    }
    const text = checkText(checker, `${itemPath}.text`, rawItem['text'], {
      min: 1,
      max: LIMITS.uncertainTextMax,
    });
    const reason = checkText(checker, `${itemPath}.reason`, rawItem['reason'], {
      min: 1,
      max: LIMITS.uncertainReasonMax,
    });
    if (text === undefined || reason === undefined) return;

    // `resolution` 是用户在预览时填的（契约 6.2），模型不该产出它。
    // 万一产出了，直接忽略——它会被预览流程覆盖掉。
    items.push({ text, reason });
  });

  return items.length === value.length ? items : undefined;
}

/** 必填字符串。 */
function checkText(
  checker: Checker,
  path: string,
  value: unknown,
  options: { min: number; max: number },
): string | undefined {
  if (typeof value !== 'string') {
    checker.problem(path, `必须是字符串，现在是 ${describeType(value)}`);
    return undefined;
  }
  return checkStringShape(checker, path, value, options);
}

/** 可选字符串。整个字段不写、或写成空串，都算「没有」。 */
function checkOptionalText(
  checker: Checker,
  path: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    checker.problem(path, `必须是字符串，现在是 ${describeType(value)}`);
    return undefined;
  }
  const checked = checkStringShape(checker, path, value, { min: 0, max });
  return checked === '' ? undefined : checked;
}

/** 契约 4.4 的通用字符串规则 + 长度。返回 undefined 表示这处已经报过错。 */
function checkStringShape(
  checker: Checker,
  path: string,
  value: string,
  options: { min: number; max: number },
): string | undefined {
  const before = checker.problems.length;

  if (/[\n\r]/.test(value)) {
    checker.problem(path, '不能包含换行。所有字符串都必须是单行的。');
  }
  if (STRUCTURAL_START.test(value)) {
    checker.problem(
      path,
      `不能以 Markdown 结构符号开头（${JSON.stringify(value.slice(0, 12))}…）。` +
        `这会在渲染后伪造出并不存在的标题或列表。`,
    );
  }
  if (CODE_FENCE.test(value)) {
    checker.problem(path, '不能包含 ``` 代码围栏。');
  }
  if (TABLE_ROW.test(value)) {
    checker.problem(path, '不能写成 Markdown 表格行（以 | 开头或结尾）。');
  }

  const length = [...value].length;
  if (length < options.min) {
    checker.problem(path, options.min === 0 ? '不能是空字符串' : `不能为空（至少 ${options.min} 个字符）`);
  } else if (length > options.max) {
    checker.problem(path, `至多 ${options.max} 个字符，现在有 ${length} 个`);
  }

  return checker.problems.length === before ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (value === undefined) return '（没有这个字段）';
  switch (typeof value) {
    case 'object':
      return '对象';
    case 'string':
      return '字符串';
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔值';
    default:
      return typeof value;
  }
}
