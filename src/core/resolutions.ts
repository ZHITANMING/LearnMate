/**
 * 存疑项裁定的解析与重放（T13 / 契约第 12 节）。
 *
 * 纯函数模块：不碰 `fs`、不联网、不看时钟、不用随机数。它只回答两个问题——
 *
 *   1. `resolutions/<input_id>.json` 里那些字节，是不是一份合法的裁定文件？
 *   2. 把这份裁定套到这份草稿上，草稿会变成什么样？有哪些地方对不上？
 *
 * 判断「对不上」时的立场是**降级、绝不静默，也绝不硬套**：一条坏记录不该让整次
 * 重处理失败，更不能被安到另一条存疑项头上——那等于替用户说了一句他没说过的话。
 */

import type {
  Block,
  NoteDraft,
  NoteRulings,
  ResolutionFile,
  ResolutionParse,
  RulingApplication,
  UncertainItem,
  UncertainRuling,
  UncertainRulingAction,
} from './contracts.js';

const ACTIONS: readonly string[] = ['drop', 'edit'];

/**
 * 读一份裁定文件。
 *
 * 形状不对就 `ok: false` 并把问题一次报全（照 `validateAnalyzeResult` 的做法）。
 * 但注意：**形状不对与「语义对不上草稿」是两件事**。这里只管形状；
 * 后者归 `applyRulings` 用 `warnings` 报。
 */
export function parseResolutionFile(value: unknown): ResolutionParse {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problems: [`顶层必须是一个 JSON 对象，现在是 ${describeType(value)}。`],
    };
  }

  const problems: string[] = [];

  const inputId = value['input_id'];
  if (typeof inputId !== 'string' || inputId === '') {
    problems.push(`\`input_id\` 必须是字符串，现在是 ${describeType(inputId)}。`);
  }

  const ts = value['ts'];
  if (typeof ts !== 'string' || ts === '') {
    problems.push(`\`ts\` 必须是字符串，现在是 ${describeType(ts)}。`);
  }

  const rawNotes = value['notes'];
  if (!Array.isArray(rawNotes)) {
    problems.push(`\`notes\` 必须是数组，现在是 ${describeType(rawNotes)}。`);
    return { ok: false, problems };
  }

  const notes: NoteRulings[] = [];

  for (const [notePosition, rawNote] of rawNotes.entries()) {
    const where = `notes[${String(notePosition)}]`;

    if (!isPlainObject(rawNote)) {
      problems.push(`${where} 必须是对象，现在是 ${describeType(rawNote)}。`);
      continue;
    }

    const noteIndex = rawNote['note_index'];
    if (!isPositiveInteger(noteIndex)) {
      problems.push(
        `${where}.note_index 必须是 1 起的整数，现在是 ${describeType(noteIndex)}。`,
      );
      continue;
    }

    const rawItems = rawNote['items'];
    if (!Array.isArray(rawItems)) {
      problems.push(`${where}.items 必须是数组，现在是 ${describeType(rawItems)}。`);
      continue;
    }

    const items: UncertainRuling[] = [];

    for (const [itemPosition, rawItem] of rawItems.entries()) {
      const itemWhere = `${where}.items[${String(itemPosition)}]`;
      const item = readRuling(rawItem, itemWhere, problems);
      if (item !== null) items.push(item);
    }

    notes.push({ note_index: noteIndex, items });
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    file: {
      input_id: inputId as string,
      ts: ts as string,
      notes,
    },
  };
}

/**
 * 把一篇笔记上的裁定套到草稿上。
 *
 * 返回的是**新草稿**：传进来的那份一个字段都不动（重放可能被调两次——预览一次、
 * 真正写盘一次——就地改会让第二次的结果和第一次不一样）。
 *
 * `inputId` 只用于拼警告里的定位信息，不参与判断。
 *
 * `rulings` 为 `null` 表示「没有任何裁定」（文件不存在、或整个文件读不出来），
 * 这时原样返回草稿、没有任何警告——这是**正常路径**，不是错误。
 */
export function applyRulings(
  draft: NoteDraft,
  noteIndex: number,
  rulings: NoteRulings | null,
  inputId: string,
): RulingApplication {
  if (rulings === null || rulings.items.length === 0) {
    return { draft, warnings: [], applied: 0 };
  }

  const positions = new Map<UncertainItem, number>();
  for (const item of uncertainItems(draft)) {
    positions.set(item, positions.size + 1);
  }

  const dropped = new Set<UncertainItem>();
  const edited = new Map<UncertainItem, string>();
  const warnings: string[] = [];
  let applied = 0;

  for (const ruling of rulings.items) {
    const item = itemAt(positions, ruling.item_index);
    const where = `${inputId} 第 ${String(noteIndex)} 篇的存疑项 #${String(ruling.item_index)}`;

    if (item === undefined) {
      warnings.push(
        `${where} 在这份草稿里不存在（这篇一共有 ${String(positions.size)} 条存疑项）：` +
          `这条「${rulingLabel(ruling.action)}」裁定已忽略，按保留处理。`,
      );
      continue;
    }

    if (item.text !== ruling.text) {
      warnings.push(
        `${where} 的原文和裁定文件对不上：裁定文件里写的是 ${JSON.stringify(ruling.text)}，` +
          `草稿里是 ${JSON.stringify(item.text)}。` +
          `这条「${rulingLabel(ruling.action)}」裁定已忽略，按保留处理。`,
      );
      continue;
    }

    if (ruling.action === 'drop') {
      dropped.add(item);
      applied += 1;
      continue;
    }

    const text = ruling.resolution === undefined ? '' : ruling.resolution.trim();
    if (text === '') {
      warnings.push(
        `${where} 的裁定是「改写」但没有写更正内容：按保留处理。`,
      );
      continue;
    }

    edited.set(item, text);
    applied += 1;
  }

  if (dropped.size === 0 && edited.size === 0) {
    return { draft, warnings, applied };
  }

  const blocks = draft.blocks.map((block: Block): Block => {
    if (block.type !== 'uncertain') return block;
    return {
      ...block,
      items: block.items
        .filter((item) => !dropped.has(item))
        .map((item) => {
          const text = edited.get(item);
          return text === undefined ? item : { ...item, resolution: text };
        }),
    };
  });

  return { draft: { ...draft, blocks }, warnings, applied };
}

/* ------------------------------------------------------------------ *
 * 下面都是私有的
 * ------------------------------------------------------------------ */

/** 按 `item_index` 找第几条存疑项（1 起）。找不到返回 `undefined`。 */
function itemAt(
  positions: ReadonlyMap<UncertainItem, number>,
  index: number,
): UncertainItem | undefined {
  for (const [item, position] of positions) {
    if (position === index) return item;
  }
  return undefined;
}

/** 草稿里全部存疑项，按块顺序、块内顺序排——就是用户在预览里看到的编号顺序。 */
function uncertainItems(draft: NoteDraft): UncertainItem[] {
  const items: UncertainItem[] = [];
  for (const block of draft.blocks) {
    if (block.type !== 'uncertain') continue;
    for (const item of block.items) items.push(item);
  }
  return items;
}

function readRuling(
  value: unknown,
  where: string,
  problems: string[],
): UncertainRuling | null {
  if (!isPlainObject(value)) {
    problems.push(`${where} 必须是对象，现在是 ${describeType(value)}。`);
    return null;
  }

  const itemIndex = value['item_index'];
  if (!isPositiveInteger(itemIndex)) {
    problems.push(`${where}.item_index 必须是 1 起的整数，现在是 ${describeType(itemIndex)}。`);
    return null;
  }

  const text = value['text'];
  if (typeof text !== 'string') {
    problems.push(`${where}.text 必须是字符串，现在是 ${describeType(text)}。`);
    return null;
  }

  const action = value['action'];
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    problems.push(
      `${where}.action 只能是 ${ACTIONS.map((item) => `\`${item}\``).join(' 或 ')}，` +
        `现在是 ${describeType(action)}。`,
    );
    return null;
  }

  const resolution = value['resolution'];
  if (resolution !== undefined && typeof resolution !== 'string') {
    problems.push(
      `${where}.resolution 必须是字符串，现在是 ${describeType(resolution)}。`,
    );
    return null;
  }

  const ruling: UncertainRuling = {
    item_index: itemIndex,
    text,
    action: action as UncertainRulingAction,
  };

  if (resolution !== undefined) ruling.resolution = resolution;
  return ruling;
}

function rulingLabel(action: UncertainRulingAction): string {
  return action === 'drop' ? '删除' : '改写';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  if (value === undefined) return 'undefined';
  return typeof value;
}
