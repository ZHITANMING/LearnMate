/**
 * `learnmate reprocess` 的**计划层**：只回答「这次要重写哪几篇、每篇的元数据从哪来」，
 * 一个字节都不写、不读时钟、不生成随机数。
 *
 * 为什么把这一层单独拿出来：重处理最危险的地方不是渲染，而是**认错对象**。用户说
 * 「重渲染这次输入」，盘上可能有 13 篇笔记、台账里有 13 行 ok、还有一份当年的草稿；
 * 「哪篇对哪条」这件事一旦算错，轻则笔记换 id（文件名跟着变、看起来像新笔记），
 * 重则覆盖掉别人的内容。把这套对应用一个纯函数算清楚，就能在不碰文件系统的前提下
 * 把它测透（tests/reprocess.test.ts 里绝大多数用例都是在测它）。
 *
 * 三条规则来自契约 §12：
 *
 * 1. **靠标题配对，不靠 `note_index`。** 台账里的 `note_index` 只在用户跳过某些条目
 *    时才有空档，而 `rebuild-index` 重建索引时是按 id 排序重推的——空档会被抹平。
 *    标题才是一批草稿里稳定且互不相同的坐标（`core/validate.ts` 强制同批标题不重复）。
 * 2. **配上对的笔记沿用原来的 id 与 created。** 否则笔记会「年轻化」：文件名里的
 *    id8 变了、`created` 也变了，用户眼里就是一篇新笔记顶掉旧的。
 * 3. **一个字节都不许改，所以「没变」要算得出来。** 这里只产出「按盘上那份的 updated
 *    渲染」的元数据；渲染器和盘上文件逐字节比较是调用方的事（见 pipeline.ts）。
 */

import type {
  NoteDraft,
  NoteFrontmatter,
  NoteStatus,
  RulingApplication,
  UncertainItem,
  UncertainRuling,
} from './contracts.js';
import { applyRulings } from './resolutions.js';

/** `--reanalyze` 之后新笔记的状态取值，与 `add --yes` 保持一致。 */
export type ReprocessStatus = 'inbox' | 'processed';

export interface PlannedNote {
  /** 1 起的序号。和 `NoteRulings.note_index`、台账的 `note_index` 同一套编号。 */
  index: number;
  /** 草稿里那一条。 */
  draft: NoteDraft;
  /** 写进 frontmatter 的 `input_id`（这次输入/这批笔记共用的那一个）。 */
  inputId: string;
  /** 沿用既有笔记时是它原来的 id；没有对应笔记时是新造的 id。 */
  noteId: string;
  /** 沿用既有笔记时的 created；新建时等于 createdFallback。 */
  created: string;
  /** 盘上已经有这篇笔记时为 true（false = 这次要新建一篇）。 */
  existing: boolean;
  /** 既有笔记在知识库里的相对路径（`notes/xxx.md`）；新建时为 null。 */
  existingPath: string | null;
  /**
   * 写进 frontmatter 的 status。
   *
   * 既有笔记沿用**它自己**的（可能是 `inbox` / `reviewed`）；新建的才按
   * `input.statusForNew` 取 `inbox` 或 `processed`。
   */
  status: NoteStatus;
  /** 写进 frontmatter 的 source_ref（只在已知时给出）。 */
  sourceRef?: string;
  /**
   * 这份草稿对应的 `source_hash`。
   *
   * 按对象分成两种情况：`--input <input_id>` 选的是一次输入，整批共享一个值；
   * `--note` / `--source` 选的是笔记，**每篇笔记有自己的指纹**（`--source` 恰恰就是
   * 用户用指纹来挑笔记的方式）。所以这个字段逐篇给，而不是整批一个。
   */
  sourceHash: string;
  /** 写进 frontmatter 的 model（台账优先，其次既有笔记，最后调用方给的兜底）。 */
  model: string;
  /** 写进 frontmatter 的 prompt_version，来源同 model。 */
  promptVersion: string;
  /** 盘上那篇笔记当时的 `updated`，渲染比对时用它。新建时为 null。 */
  existingUpdated: string | null;
}

export type ReprocessWarningKind = 'no_source_hash' | 'no_generation_record';

export interface ReprocessWarning {
  kind: ReprocessWarningKind;
  message: string;
}

export type ReprocessPlan =
  | {
      ok: true;
      /** 这次输入/这批笔记共用的 input_id（`--input` 路就是它本身）。 */
      inputId: string;
      targets: PlannedNote[];
      /** 草稿里有、盘上找不到对应笔记的条数（它们会被当成新笔记写出去）。 */
      orphanDraftNotes: number;
      /** 盘上有笔记、这次的草稿里找不到对应标题的篇数（不动它们）。 */
      orphanExisting: number;
      warnings: ReprocessWarning[];
    }
  | { ok: false; problems: readonly string[] };

export interface MapDraftNotesInput {
  /** 1 起、与草稿 `notes` 数组下标一一对应的 input_id。 */
  inputId: string;
  /** `draft/<input_id>.json` 里的 `notes`。 */
  notes: readonly NoteDraft[];
  /** 盘上现有的全部笔记（`readNoteSummaries` 的结果，读不懂的已在里面标了 null）。 */
  existing: readonly { relativePath: string; frontmatter: NoteFrontmatter | null }[];
  /** 这次输入/这批共用的 `source_hash`；逐篇优先用既有笔记自己的。 */
  sourceHash?: string;
  /** 台账里同一 input_id 的行用的 `model` / `prompt_version`（首选）。 */
  ledgerModel?: string;
  ledgerPromptVersion?: string;
  fallbackModel?: string;
  fallbackPromptVersion?: string;
  /** created 与模型的 `source_hash` 都无从得知时用这个（调用方注入的 now，见 AddOptions.now）。 */
  createdFallback: string;
  /** 新建笔记的 status（`--yes` 与否由调用方决定，这里不猜）。 */
  statusForNew: ReprocessStatus;
  /** 造新 id 的函数（调用方注入，纯函数里不许自己摇）。 */
  newId: () => string;
}

/**
 * 把草稿里的每一条对到盘上的某篇笔记（或判明它是新的）。
 *
 * 配对只看标题：同一批草稿的标题必然互不相同（`core/validate.ts` 的检查），而
 * 标题会进文件名，所以「标题相同」与「同一篇」在这里是同一件事。
 */
export function mapDraftNotes(input: MapDraftNotesInput): ReprocessPlan {
  const inputId = input.inputId;

  // 草稿自己撞名（用户手工改过 `draft/*.json`）时不许猜：没有任何依据能判断
  // 哪条对应哪篇，硬猜的结果是静默覆盖别人的笔记。整批拒绝，退出码 3。
  const problems: string[] = [];
  const seenTitles = new Map<string, number>();
  input.notes.forEach((note, index) => {
    const previous = seenTitles.get(note.title);
    if (previous !== undefined) {
      problems.push(
        `草稿里第 ${String(previous + 1)} 条与第 ${String(index + 1)} 条标题一样` +
          `（${JSON.stringify(note.title)}）。标题是笔记在盘上的唯一配对依据，` +
          '两条同标题就没法判断各自对应哪一篇，所以这次一条都不会重写。',
      );
      return;
    }
    seenTitles.set(note.title, index);
  });
  if (problems.length > 0) return { ok: false, problems };

  // 盘上的笔记按标题索引，但**只在「这次输入自己产出的笔记」里配对**：
  // `frontmatter.input_id` 必须等于正在重处理的 input_id。
  //
  // 为什么必须限定：同一份原文被整理过两次是完全正常的（真实数据里
  // `01M3NR4AMKFP6HMM31WYSTTSSX` 与 `01M3PD5P2YBCCR5MYYVX5MWMFQ` 就是同一份原文的
  // 两代产出，各拆出 13 篇与 8 篇，标题大量重叠）。不限定 input_id 的话，重处理第二代
  // 会把第一代的笔记按标题「配上对」然后就地覆盖——那些笔记的 id 与 created 是第一代的，
  // 内容却被换成第二代的，`input_id` 还会被改写成第二代，等于把两代搅在一起、
  // 而且用户根本没要求动第一代。
  //
  // 配不上就当成新笔记写（下面 orphanDraftNotes 会报出来）：
  // 当年被 q 取消的那次输入，盘上一篇都没有，8 条就该是 8 篇新笔记。
  const byTitle = new Map<string, { relativePath: string; frontmatter: NoteFrontmatter }>();
  for (const summary of input.existing) {
    const frontmatter = summary.frontmatter;
    if (frontmatter === null) continue; // 读不懂 frontmatter 的没法配对：没有 id 就写不出笔记
    if (frontmatter.input_id !== inputId) continue; // 别的输入的笔记，不归这次重处理管
    if (byTitle.has(frontmatter.title)) continue; // id8 不唯一时同标题可能不止一篇
    byTitle.set(frontmatter.title, { relativePath: summary.relativePath, frontmatter });
  }

  const targets: PlannedNote[] = [];
  const warnings: ReprocessWarning[] = [];
  const matchedPaths = new Set<string>();
  const missingGeneration: string[] = [];
  const missingSourceHash: string[] = [];
  let orphanDraftNotes = 0;
  let warnedGeneration = false;

  input.notes.forEach((draft, index) => {
    const match = byTitle.get(draft.title);
    const frontmatter = match?.frontmatter ?? null;
    if (match === null || match === undefined) {
      orphanDraftNotes += 1;
    } else {
      matchedPaths.add(match.relativePath);
    }

    // `source_hash` 与 `model` / `prompt_version` 都是 frontmatter 的必填字段：
    // 拿不到一个值就写不出一篇合契约的笔记。**绝不猜**，报出来让用户去 --reanalyze。
    const perNoteHash = frontmatter?.source_hash ?? input.sourceHash;
    if (perNoteHash === undefined || perNoteHash === '') {
      missingSourceHash.push(`第 ${String(index + 1)} 条「${draft.title}」`);
    }

    const model = input.ledgerModel ?? frontmatter?.model ?? input.fallbackModel;
    const promptVersion =
      input.ledgerPromptVersion ?? frontmatter?.prompt_version ?? input.fallbackPromptVersion;
    if (model === undefined || promptVersion === undefined) {
      missingGeneration.push(`第 ${String(index + 1)} 条「${draft.title}」`);
      if (!warnedGeneration) {
        warnedGeneration = true;
        warnings.push({
          kind: 'no_generation_record',
          message:
            '这次输入没有留下生成记录（台账与既有笔记里都没有 model / prompt_version）——' +
            '重渲染出来的笔记没法如实写明它是哪个模型、哪版提示词产出的。' +
            '要重新分析请用：reprocess --input <input_id> --reanalyze。',
        });
      }
    }

    // 配上对的笔记：status 沿用**它自己**的，绝不重算。
    //
    // 重算会当场毁掉幂等：`--yes` 新建时写进 frontmatter 的是 `inbox`（与 `add --yes`
    // 一致），而重算出来的固定是 `processed`——于是第二次重跑会把 8 篇的 status 全改一遍，
    // 报「8 条会改写」而不是「8 条全部未变化」（这正是验收里「连跑两次第二次零写入」那一条）。
    // 用户的 status 是他自己标的，重渲染排版没有理由动它。
    const status: NoteStatus =
      frontmatter === null ? input.statusForNew : existingStatus(frontmatter);

    targets.push({
      index: index + 1,
      draft,
      inputId: input.inputId,
      noteId: frontmatter?.id ?? input.newId(),
      created: frontmatter?.created ?? input.createdFallback,
      existing: frontmatter !== null,
      existingPath: match?.relativePath ?? null,
      status,
      ...(frontmatter?.source_ref === undefined ? {} : { sourceRef: frontmatter.source_ref }),
      sourceHash: perNoteHash ?? '',
      model: model ?? '',
      promptVersion: promptVersion ?? '',
      existingUpdated: frontmatter?.updated ?? null,
    });
  });

  if (missingSourceHash.length > 0 || missingGeneration.length > 0) {
    const problems: string[] = [];
    if (missingSourceHash.length > 0) {
      problems.push(
        `这份草稿拿不到 source_hash（台账、既有笔记、raw/ 里都没有）：` +
          `${missingSourceHash.join('、')}。\n` +
          '  source_hash 是「同一份原文只处理一次」的唯一依据，猜一个出来就等于让查重失效。',
      );
    }
    if (missingGeneration.length > 0) {
      problems.push(
        `这份草稿拿不到 model / prompt_version（台账与既有笔记里都没有）：` +
          `${missingGeneration.join('、')}。\n` +
          '  这两个字段写不出真实值，笔记就不该假装自己知道是哪个模型产出的。',
      );
    }
    return { ok: false, problems };
  }

  return {
    ok: true,
    inputId,
    targets,
    orphanDraftNotes,
    orphanExisting: countOrphanExisting(input.existing, matchedPaths, inputId),
    warnings,
  };
}

/**
 * 既有笔记该用哪个 status。
 *
 * 沿用盘上那篇的旧值？不行——`status` 是「这条笔记现在处于什么状态」，重渲染之后
 * 内容变了，旧的状态可能已经不成立；而且契约里 `status` 的取值只有三种，盘上那份
 * 万一是废弃值，写回去只会把问题留得更久。所以统一按这次的动作定：新建 = 这一批
 * 的状态（`--yes` 是 inbox，交互确认过是 processed），改写 = processed。
 */
/**
 * 既有笔记的 status 原样沿用。
 *
 * 只放行三种合法取值（`core/contracts.ts` 的 `NoteStatus`）；认不出来的值退回 `processed`，
 * 而不是把它原样写回去——重渲染不该把一个不合契约的 status 继续传播下去。
 */
function existingStatus(frontmatter: NoteFrontmatter): NoteStatus {
  if (
    frontmatter.status === 'inbox' ||
    frontmatter.status === 'processed' ||
    frontmatter.status === 'reviewed'
  ) {
    return frontmatter.status;
  }
  return 'processed';
}

/**
 * 「这次输入自己产出的笔记里，草稿没覆盖到的」篇数。
 *
 * 必须和 `byTitle` 用同一个范围（`frontmatter.input_id === inputId`），否则会把别的输入的
 * 笔记算成「这次草稿里找不到它」——真实数据里那会一口气报出 25 篇无关笔记。
 */
function countOrphanExisting(
  existing: readonly { relativePath: string; frontmatter: NoteFrontmatter | null }[],
  matchedPaths: ReadonlySet<string>,
  inputId: string,
): number {
  let count = 0;
  for (const summary of existing) {
    if (summary.frontmatter === null) continue;
    if (summary.frontmatter.input_id !== inputId) continue;
    if (!matchedPaths.has(summary.relativePath)) count += 1;
  }
  return count;
}

/** `--input <input_id>` 这一路要的事先检查都在这里，出来的问题直接进退出码 3。 */
export function checkPlanTargets(plan: Extract<ReprocessPlan, { ok: true }>): readonly string[] {
  const problems: string[] = [];
  for (const target of plan.targets) {
    if (target.sourceHash === '') {
      problems.push(`第 ${String(target.index)} 条「${target.draft.title}」拿不到 source_hash。`);
    }
  }
  return problems;
}

/**
 * 把一份 `resolutions/<input_id>.json` 重放到某一篇草稿上。
 *
 * 只是 `applyRulings` 的一层薄包装，存在的理由是**让调用方只 import 一个东西**，
 * 并且把「这次重放针对的是哪篇」这件事记在名字里。
 */
export function replayRulings(
  draft: NoteDraft,
  noteIndex: number,
  rulings: unknown,
  inputId: string,
): RulingApplication {
  return applyRulings(draft, noteIndex, isNoteRulingsLike(rulings) ? rulings : null, inputId);
}

/** 形状判断交给 `core/resolutions.ts` 的解析器，这里只做一次宽松的收窄。 */
function isNoteRulingsLike(value: unknown): value is {
  note_index: number;
  items: UncertainRuling[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { note_index?: unknown; items?: unknown };
  return typeof candidate.note_index === 'number' && Array.isArray(candidate.items);
}

/** 摊平一篇草稿里的全部存疑项（与 pipeline.ts 的同名私有函数语义一致）。 */
export function uncertainItems(draft: NoteDraft): UncertainItem[] {
  const items: UncertainItem[] = [];
  for (const block of draft.blocks) {
    if (block.type === 'uncertain') items.push(...block.items);
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * 候选清单（无参数时打印什么、一个指纹对多个输入时报什么）
 * ------------------------------------------------------------------ */

export interface ReprocessCandidate {
  inputId: string;
  /** 台账里的 source_hash；台账里没有这次输入的行时为 null。 */
  sourceHash: string | null;
  /** 台账里这次输入的行数（含 ok 与其他结局）。 */
  ledgerRows: number;
  /** 盘上 frontmatter 的 input_id 等于它的笔记篇数。 */
  noteCount: number;
  hasDraft: boolean;
  /**
   * 草稿里有多少条笔记；`null` 表示「有草稿但读不出条数」（文件坏/不是 JSON）。
   *
   * 与 `noteCount` 是两件事：前者是「重渲染会产出几篇」，后者是「盘上现在已有几篇」。
   * 真实数据里 `01M3PD5P2YBCCR5MYYVX5MWMFQ` 是草稿 8 条、盘上 0 篇——
   * 恰好是 reprocess 最有用的一种输入，所以两个数字都要报出来。
   */
  draftNotes: number | null;
  hasResolutions: boolean;
}

/**
 * 按 input_id 汇总「现在能重处理什么」。
 *
 * 数据来源是三个目录加台账，**三次来源都列出来**：只有草稿没有台账行是真实存在的
 * 状态（真实数据里 `01M3NQS4SPPTFZY58V0F2DTSZY` 就是），所以只要三者里有任何一个
 * 提到这个 input_id，它就该出现在候选清单里，让用户自己判断。
 */
export function listCandidates(input: {
  drafts: ReadonlyMap<string, number | null>;
  ledgerInputIds: readonly string[];
  ledgerSourceHashes: ReadonlyMap<string, string>;
  ledgerRowCounts: ReadonlyMap<string, number>;
  noteInputIds: ReadonlyMap<string, number>;
  resolutionInputIds: readonly string[];
}): ReprocessCandidate[] {
  const ids = new Set<string>([
    ...input.drafts.keys(),
    ...input.ledgerInputIds,
    ...input.noteInputIds.keys(),
  ]);
  const resolutionIds = new Set(input.resolutionInputIds);

  const candidates: ReprocessCandidate[] = [];
  for (const inputId of ids) {
    candidates.push({
      inputId,
      sourceHash: input.ledgerSourceHashes.get(inputId) ?? null,
      ledgerRows: input.ledgerRowCounts.get(inputId) ?? 0,
      noteCount: input.noteInputIds.get(inputId) ?? 0,
      hasDraft: input.drafts.has(inputId),
      draftNotes: input.drafts.get(inputId) ?? null,
      hasResolutions: resolutionIds.has(inputId),
    });
  }
  candidates.sort((left, right) => left.inputId.localeCompare(right.inputId));
  return candidates;
}
