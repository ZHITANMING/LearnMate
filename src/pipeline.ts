/**
 * `learnmate add` 的完整流程。
 *
 * 架构文档（docs/02-architecture.md）把这里定义成「**唯一**知道完整流程的地方」：
 * 顺序（契约第 6.1 节那四步写入）、失败分流（哪个错误配哪个退出码）、以及
 * `--dry-run` / `--yes` / `--force` 的语义，全都只在这里落地一次。
 * 别的模块各管一件事——`ingest` 只懂规范化、`analyze` 只懂和模型打交道、
 * `render` 只懂 Markdown、`vault` 只懂文件。这里把它们按正确的顺序串起来。
 *
 * 为什么流程要被写死在**一个**函数里：这条链路上最难的不是任何单步，而是
 * 「什么时候已经写了、什么时候还没写」。散在三个命令里之后，「模型超时会不会
 * 丢掉我的原文」这种问题就没人能一眼回答了——而那个问题的答案是这个项目
 * 最核心的承诺。
 *
 * 本模块属于编排层：允许碰文件、允许读时钟、允许生成 id。
 */

import { join } from 'node:path';
import type {
  Block,
  ChatFunction,
  LedgerEntry,
  LedgerInputRow,
  LedgerNoteRow,
  LedgerRecordableOutcome,
  NoteDraft,
  NoteFrontmatter,
  NoteMeta,
  NoteRulings,
  NoteStatus,
  UncertainItem,
  UncertainRuling,
} from './core/contracts.js';
import { analyze, type AnalyzeOutcome } from './core/analyze.js';
import {
  EXIT,
  LlmError,
  UnsafeWriteError,
  UsageError,
  ValidationError,
  describeError,
  type ExitCode,
} from './core/errors.js';
import { ingest } from './core/ingest.js';
import { renderNote } from './core/render.js';
import { parseResolutionFile } from './core/resolutions.js';
import {
  checkPlanTargets,
  mapDraftNotes,
  replayRulings,
  uncertainItems,
  type PlannedNote,
  type ReprocessPlan,
} from './core/reprocess.js';
import { appendEntries, findSuccessfulBatch, readLedger } from './io/ledger.js';
import { collectKnownTags, readNoteSummaries } from './io/notes.js';
import {
  draftFilePath,
  ensureVaultLayout,
  fileExists,
  listResolutionFiles,
  moveNoteToTrash,
  noteFilePath,
  readRaw,
  readResolutions,
  readText,
  resolutionFilePath,
  vaultRelativePath,
  writeDraft,
  writeNote,
  writeQuarantine,
  writeRaw,
  writeResolutions,
  type VaultPaths,
} from './io/vault.js';
import { newUlid } from './util/id.js';
import { fingerprint } from './util/hash.js';
import { noteFileName } from './util/slug.js';

/**
 * frontmatter 的结构版本（契约第 3 节，当前为 1）。
 *
 * 没有放在 `core/contracts.ts`：那个文件是**类型**定义，一个值都不该有。
 * 也没有放在 `render.ts`：渲染器只是把调用方给的值原样写进文件，它不该知道
 * 当前版本是几——「现在写第几版」是流程的决定，不是渲染的决定。
 */
export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 预览交互
 * ------------------------------------------------------------------ */

/** 交给用户看的一条笔记。 */
export interface NotePreview {
  /** 从 1 开始的序号。 */
  index: number;
  total: number;
  /** 已经应用过存疑裁定的草稿——就是将要落盘的那一份。 */
  draft: NoteDraft;
  /** 渲染好的完整笔记（含 frontmatter），与最终写进文件的内容**逐字符相同**。 */
  markdown: string;
}

/** 用户的回答。 */
export type NoteDecision = 'write' | 'skip' | 'accept-all' | 'quit';

/** 一处存疑项，连同它属于哪条笔记。 */
export interface UncertainPreview {
  /** 这条笔记在整批里的序号，从 1 开始。 */
  noteIndex: number;
  noteTotal: number;
  /** 这一处存疑在这条笔记里排第几，从 1 开始。 */
  index: number;
  total: number;
  item: UncertainItem;
}

/** 用户对一处存疑项的裁定。 */
export type UncertainResolution =
  | { action: 'keep' }
  | { action: 'drop' }
  | { action: 'edit'; text: string };

/**
 * 提问的那一方。
 *
 * 抽成接口是为了让 `pipeline` 既不知道 readline、也不需要知道屏幕宽度——
 * 于是「按 n 会怎样」这种问题可以在测试里用一行脚本回答，而不是去模拟终端。
 * 真实的实现在 `src/commands/add.ts`。
 */
export interface AddPrompter {
  confirmNote(preview: NotePreview): Promise<NoteDecision>;
  resolveUncertain(preview: UncertainPreview): Promise<UncertainResolution>;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export interface AddOptions {
  paths: VaultPaths;
  /** 提示词模板正文，由 `io/prompt.ts` 读好传进来。 */
  template: string;
  /** 模型标识，写进 frontmatter 与台账。 */
  model: string;
  promptVersion: string;
  /** 「发一段对话」的能力。真实实现是 `io/llm.ts`，测试里是假的。 */
  chat: ChatFunction;
  maxInputChars: number;
  /** 输入来源的名字，**只存文件名**（完整路径会泄露用户名和目录结构）。从标准输入读时没有。 */
  sourceRef?: string;
  /** 标签词表。不传就从台账里取（`collectKnownTags`）。 */
  tags?: readonly string[];
  /** 校验失败后最多重试几次。不传就用 `core/analyze.ts` 的默认值。 */
  maxRetries?: number;
  /** 跳过全部交互，等于「全部写入 + 存疑项全部保留为待确认」。 */
  yes?: boolean;
  /**
   * 一个文件都不写。
   *
   * **它仍然会调用模型**——不调就没有东西可预览，而「预览」正是这个开关的意义所在。
   * 所以 `--dry-run` 省的是磁盘写入的后悔，不是 API 费用。
   */
  dryRun?: boolean;
  /** 忽略「这份输入已经处理过」，照常重跑（新笔记用新 id，旧笔记文件不动）。 */
  force?: boolean;
  /** 预览交互实现。`yes` 为真时不会被调用。 */
  prompter?: AddPrompter;
  /** 进度输出，默认写标准输出。 */
  log?: (message: string) => void;
  /** 注入时钟，测试用。 */
  now?: () => Date;
  /** 注入 id 生成器，测试用。 */
  newId?: () => string;
  /**
   * 直接用这份「已经规范化过」的原文，跳过 `ingest`。
   *
   * 只给 `reprocess --reanalyze` 用：它要重新分析的正是 `raw/<input_id>.txt` 里那份
   * **当年已经规范化过**的正文（契约 §5.5 保证规范化是幂等的，所以再跑一遍 `ingest`
   * 结果完全一样，但那需要把 `raw/` 读进来当字符串传一圈，没有任何收益）。
   */
  ingestOverride?: { normalized: string; hash: string; charCount: number };
  /**
   * 第一次真的要把字节写进 `notes/` 之前调一次（`--dry-run` 也会调）。
   *
   * `--reanalyze` 用它把同一 `input_id` 的旧笔记搬进 `trash/`：位置在「用户已经确认、
   * 且不会再有整批拒绝」之后，所以 q 取消、撞名、`--dry-run` 三种情况下旧笔记都原封不动。
   */
  beforeWrite?: () => void;
  /**
   * 这一批最后**一条笔记都没写**（用户 q 取消，或者撞名整批拒绝）时调一次。
   *
   * 给 `--reanalyze` 把刚搬进 `trash/` 的旧笔记放回 `notes/`：搬-放必须成对出现，
   * 否则用户按一次 q 就发现笔记没了——那是这个项目最不能出的事。
   */
  afterCancel?: () => void;
}

/** 预览阶段定下来的一条笔记。 */
interface DecidedNote {
  /** 0 起的下标，只用来指认「第几条」。 */
  index: number;
  noteId: string;
  draft: NoteDraft;
  markdown: string;
  status: NoteStatus;
  accepted: boolean;
  /** 这条笔记里的存疑项总数。 */
  uncertainTotal: number;
  /** 最终会渲染进笔记的存疑项数量。 */
  uncertainKept: number;
}

/**
 * 跑完一次 `add`。
 *
 * 返回值只覆盖「流程正常走完」的情况（0）。用法错误（2）、校验失败（3）、
 * 外部服务错误（4）都按既有的异常通道往外抛，由 `src/main.ts` 统一打印并翻译成退出码——
 * 异常到退出码的翻译只有那一个落地点，这里不重复造。
 *
 * 唯一的例外是校验失败：它会先在这里把现场写进 `quarantine/`（那是流程的一步，
 * 属于「什么时候写了什么」），然后把错误继续抛出去。
 */
export async function runAdd(input: string, options: AddOptions): Promise<ExitCode> {
  const log = options.log ?? writeLine;
  const dryRun = options.dryRun === true;
  const yes = options.yes === true;
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? newUlid;

  // ① 规范化 + 指纹。输入超长会在这里抛 UsageError（退出码 2）——此刻一个字节都还没写。
  //    `--reanalyze` 走 override：它手上那份正文已经在 raw/ 里待着，当年就规范化过了。
  const ingested = options.ingestOverride ?? ingest(input, {
    maxInputChars: options.maxInputChars,
    ...(options.sourceRef === undefined ? {} : { sourceLabel: options.sourceRef }),
  });
  log(`已读取 ${String(ingested.charCount)} 字，指纹 ${ingested.hash}`);

  // ② 查重：只认台账里 outcome = ok 的记录（契约第 6.5 节）。
  //    注意这一步在写任何东西之前，所以「已经处理过」绝不会留下新痕迹。
  if (!options.force) {
    const previous = findSuccessfulBatch(options.paths, ingested.hash);
    if (previous !== null) {
      log(`这份输入已于 ${previous.ts} 处理过，产出 ${String(previous.note_total)} 条笔记。`);
      log('如需重新处理，请用 reprocess，或加 --force 强制重跑。');
      return EXIT.OK;
    }
  }

  const inputId = newId();
  const stamp = formatTimestamp(now());

  /**
   * 组装一条笔记的 frontmatter 元数据。
   *
   * 用闭包而不是「参数齐全的函数」：`inputId`/`stamp`/`source_hash`/模型名这些是
   * **整批共享**的，每条笔记只有 id 和状态不同。写成参数列表的话，每调用一次就要把
   * 同样的四五个值再抄一遍，抄错一个就是「frontmatter 和台账对不上」这种最难查的问题。
   */
  const metaFor = (noteId: string, status: NoteStatus): NoteMeta => {
    const meta: NoteMeta = {
      id: noteId,
      inputId,
      // created 与 updated 此刻是同一个值：笔记刚生成，还没被改过。
      created: stamp,
      updated: stamp,
      status,
      sourceHash: ingested.hash,
      schemaVersion: SCHEMA_VERSION,
      model: options.model,
      promptVersion: options.promptVersion,
    };
    // source_ref 只在确实有来源文件时才写进 frontmatter（从标准输入读时没有）。
    return options.sourceRef === undefined ? meta : { ...meta, sourceRef: options.sourceRef };
  };

  // ③ 原文先落盘。**全流程唯一不可跳过、不可撤销的一步**：模型超时、返回垃圾、
  //    断电，都不能让用户白打一遍字。`--dry-run` 是唯一的例外（它的承诺就是一个字节都不写）。
  let rawRelative: string | null = null;
  if (!dryRun) {
    ensureVaultLayout(options.paths);
    const rawPath = writeRaw(options.paths, inputId, ingested.normalized);
    rawRelative = vaultRelativePath(options.paths, rawPath);
    log(`原文已保存：${rawRelative}`);
  }

  /**
   * 记下这次输入的结局（契约 §9.3）。**凡是走到了「原文已落盘」却没产出笔记的出口，
   * 都必须叫它一次**——出口 3（校验失败）、4（调模型失败）、5（模型说没东西可整理）、
   * 6（用户取消）、7（撞名）。出口 1 与 2 不叫（契约 §9.3 那张表）。
   *
   * 三条纪律：
   * - `--dry-run` 时不写，只说明「本来会记一行」：它的承诺是一个字节都不写。
   * - **写失败不许改变原来的结局。** 它恰恰是在「已经出事了」的时候被调用的，
   *   让「磁盘满」的异常盖掉真正的失败原因，用户就会去修一个不存在的问题。
   * - `reason` 是给用户看的一句话：密钥先抹掉，再压成单行、截断。
   *
   * 用闭包而不是参数齐全的函数，理由和 `metaFor` 一样：`stamp`/`inputId`/`source_hash`/
   * 模型名是整次输入共享的，每调用一次就重抄一遍，抄错一个就是台账和 frontmatter 对不上。
   */
  const record = (
    outcome: LedgerRecordableOutcome,
    reason: string,
    counts: { draftTotal: number; skippedTotal?: number },
  ): void => {
    const text = reasonText(reason);
    if (dryRun) {
      log(`（--dry-run）本来会往台账里记一行：${outcome} —— ${text}`);
      return;
    }
    try {
      appendEntries(options.paths, [
        buildInputEntry({
          ts: stamp,
          inputId,
          sourceHash: ingested.hash,
          model: options.model,
          promptVersion: options.promptVersion,
          outcome,
          reason: text,
          draftTotal: counts.draftTotal,
          ...(counts.skippedTotal === undefined ? {} : { skippedTotal: counts.skippedTotal }),
        }),
      ]);
    } catch (error) {
      // 台账是记录，不是拦路虎。原文和草稿都在磁盘上，这里少一行不改写上面的结局。
      log(`⚠ 台账没能记下这次输入的结局（${outcome}）：${reasonText(describeError(error))}`);
      log('  这次输入本身没有受影响，知识库里的文件也都在。');
    }
  };

  // ④ 分析。模板块坏了会在发请求之前就抛错；网络错误一次都不重试（退出码 4）；
  //    输出不合契约才会带着反馈重试（耗尽后退出码 3）。
  log(`正在分析…（${options.model}）`);
  let outcome: AnalyzeOutcome;
  try {
    outcome = await analyze({
      template: options.template,
      // 标签词表决定「模型能不能复用你已经用过的标签」。来源是 **notes/ 里笔记的
      // frontmatter**，不是台账：台账是派生数据、可以整个删掉，而词表不该跟着一起消失。
      // `learnmate tags` 命令用的是同一个函数（契约 §4.7），所以用户看到的和模型看到的
      // 永远是同一份。
      tags: options.tags ?? collectKnownTags(options.paths),
      input: ingested.normalized,
      chat: options.chat,
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      // 退出码 3 要求「现场进 quarantine/」。原文刚才已经落盘了，这里补上另一半：
      // 模型**每一次**的原始产出。少了它，事后没人能回答「模型到底回了什么」——
      // 而那个答案只存在于内存里的错误对象上，进程一退出就没了。
      saveValidationScene(options, { inputId, sourceHash: ingested.hash, error, log, dryRun });
      // 原文在、台账里却什么都没有，正是 T11 那个孤儿现场的成因：一次真实发生过的输入
      // 在记忆里彻底消失，而且没法事后发现（`rebuild-index` 从 `notes/` 重建，看不见它）。
      record('validation_failed', error.message, { draftTotal: 0 });
    } else if (error instanceof LlmError) {
      record('llm_error', error.message, { draftTotal: 0 });
    }
    throw error;
  }

  // ⑤ 草稿落盘。存的是**通过契约校验之后**的全部草稿（契约第 6.1 节第 2 步）。
  if (!dryRun) {
    const draftPath = writeDraft(options.paths, inputId, outcome.result);
    log(`草稿已保存：${vaultRelativePath(options.paths, draftPath)}`);
  }

  const notes = outcome.result.notes;

  // ⑥ 产出 0 条（契约第 4.1 节）：不进预览。退出码 0，什么都没出错。
  //    但它**要写一行台账**：`empty` 是「模型的判断」，跟用户的「跳过」是两件事。
  //    T11 捡到的那个孤儿现场（`draft/` 里是 `{"notes": []}`、台账里一行都没有）就是这里留下的。
  if (notes.length === 0) {
    log('');
    log('  这次没有可整理的笔记 —— 原文里没有找到可复用的知识点。');
    log(`  原文已保存：${rawRelative ?? '（--dry-run，没有写）'}`);
    log('  没有写入任何笔记。');
    record('empty', '模型认为原文里没有可复用的知识点。', { draftTotal: 0 });
    return EXIT.OK;
  }

  // ⑦ 预览 + 逐条确认
  log('');
  log(`拆分为 ${String(notes.length)} 条笔记：`);
  notes.forEach((note, index) => {
    log(`  ${String(index + 1).padStart(3, ' ')}. ${note.title}`);
  });

  // 每条笔记的 id 在预览**之前**就定下来：预览里显示的 frontmatter 和文件名必须
  // 与最终落盘的一模一样，否则「我预览到的」和「我得到的」就是两个东西。
  const noteIds = notes.map(() => newId());
  // `--yes` 是批量录入：写出来的笔记还没被人看过，所以是 inbox。
  // 交互式预览里按 y 的，是被用户看过的，所以是 processed。
  const statusForAccepted: NoteStatus = yes ? 'inbox' : 'processed';

  const accepted: DecidedNote[] = [];
  const skipped: DecidedNote[] = [];
  // 用户在预览里对存疑项做的非 keep 裁定，按笔记攒起来，循环之后一次写进
  // `resolutions/<input_id>.json`。`--yes` 那条路一条都不产生。
  const rulingNotes: NoteRulings[] = [];
  let acceptAll = yes;
  let quit = false;

  for (let index = 0; index < notes.length; index += 1) {
    const draft = notes[index];
    const noteId = noteIds[index];
    if (draft === undefined || noteId === undefined) continue;

    if (acceptAll) {
      // 「全部接受」连存疑项也一并按「保留」处理——否则它就只是「全部接受标题」。
      const total = uncertainItems(draft).length;
      accepted.push({
        index,
        noteId,
        draft,
        markdown: renderNote(draft, metaFor(noteId, statusForAccepted)),
        status: statusForAccepted,
        accepted: true,
        uncertainTotal: total,
        uncertainKept: total,
      });
      continue;
    }

    const prompter = requirePrompter(options.prompter);

    // 存疑项**先于**写入决定提问（契约第 6.2 节）：一条笔记里有说不准的地方，
    // 这件事本身会影响「这条我要不要」。
    const resolved = await resolveUncertainties(draft, index, notes.length, prompter);
    rulingNotes.push({ note_index: index + 1, items: resolved.rulings });
    const markdown = renderNote(resolved.draft, metaFor(noteId, statusForAccepted));
    const decision = await prompter.confirmNote({
      index: index + 1,
      total: notes.length,
      draft: resolved.draft,
      markdown,
    });

    if (decision === 'quit') {
      quit = true;
      break;
    }
    if (decision === 'accept-all') acceptAll = true;

    const note: DecidedNote = {
      index,
      noteId,
      draft: resolved.draft,
      markdown,
      status: statusForAccepted,
      accepted: decision !== 'skip',
      uncertainTotal: resolved.total,
      uncertainKept: resolved.kept,
    };
    (note.accepted ? accepted : skipped).push(note);
  }

  if (quit) {
    // 「退出」= 取消这一批。**一条都不写**，包括前面已经答过 y 的：预览是写入之前
    // 唯一的拦截机制，一个半途而废的批次比一条都不写更难收拾。
    log('');
    log('已取消：这一批一条笔记都没有写入（包括前面已经确认过的）。');
    log(`  原文和全部草稿都还在：${rawRelative ?? '（--dry-run，没有写）'}`);
    // 取消仍然是成功（退出码 0），但它是一次真实发生过的输入 —— 记下结局，顺带记下
    // 取消之前用户已经答过 n 的条数：那是「他为什么不想要这批」的唯一线索。
    record('cancelled', '用户取消了这一批。', {
      draftTotal: notes.length,
      skippedTotal: skipped.length,
    });
    // 走到这里还没写任何笔记文件。`--reanalyze` 用它把搬进 trash/ 的旧笔记放回去。
    options.afterCancel?.();
    return EXIT.OK;
  }

  // ⑦.5 把这次对存疑项的裁定落盘。放在撞名守卫**之前**：这样
  //      「笔记文件在 ⇒ 重放需要的裁定也在」；反过来的话，撞名整批不写、裁定却
  //      已经落盘，下次 reprocess 会拿一份没有对应笔记的裁定去重渲染。
  saveRulings(options, inputId, rulingNotes, now, log);

  // ⑧ 写入前统一算一遍全部目标文件名。这是撞名守卫：`id8` 后缀**挡不住**
  //    同一次输入里标题相同的两条笔记（它们的 id 前 8 位必然相同），后写的那条
  //    会静默覆盖先写的。契约第 5.3 节指明这个缺口必须在这里堵。
  try {
    assertSafeTargets(options.paths, accepted);
  } catch (error) {
    if (error instanceof UnsafeWriteError) {
      // 整批不写，但原文和草稿都在，这次输入确实发生过 —— 结局要留在台账里（出口 7）。
      record('unsafe_write', error.message, { draftTotal: notes.length });
      // 撞名整批不写，所以「该在新笔记之前腾位置」的旧笔记要放回去（--reanalyze）。
      options.afterCancel?.();
    }
    throw error;
  }

  // ⑨ 逐条写笔记（第 3 步），全部写完再一次性追加台账（第 4 步）。
  //    台账放最后：它是派生数据，宁可少几行（`rebuild-index` 能补）也不能多几行。
  const entries: LedgerEntry[] = [];
  log('');

  // ⑧.5 第一次真的要把字节写进 notes/ 了（含 --dry-run：它也要先腾出位置才能算准
  //      目标文件名）。`--reanalyze` 在这里把同一 input_id 的旧笔记搬进 trash/：
  //      放在「用户已经确认、且不会再有整批拒绝」之后，所以 q 取消、撞名、--dry-run
  //      三种情况下旧笔记都原封不动。搬完之前一条笔记都不会写。
  options.beforeWrite?.();
  for (const note of accepted) {
    if (dryRun) {
      log(`  （--dry-run）会写入：${targetRelative(options.paths, note)}`);
      continue;
    }
    const filePath = writeNote(options.paths, note.draft.title, note.noteId, note.markdown);
    const notePath = vaultRelativePath(options.paths, filePath);
    entries.push(
      buildLedgerEntry({
        ts: stamp,
        inputId,
        noteId: note.noteId,
        index: note.index,
        total: notes.length,
        sourceHash: ingested.hash,
        notePath,
        draft: note.draft,
        status: note.status,
        model: options.model,
        promptVersion: options.promptVersion,
        outcome,
        uncertainTotal: note.uncertainTotal,
        uncertainKept: note.uncertainKept,
      }),
    );
    log(`  ✓ ${note.draft.title} → ${notePath}`);
  }
  // 跳过也是这次输入的结局（契约 §9.3 出口 8）。它跟 N 行 ok 属于同一批，
  // 所以**只调一次 `appendEntries`**：分两次写，中间崩掉就会留下「台账说用户跳过了、
  // 笔记却已经写了一半」的自相矛盾历史——台账是只追加的，事后改不了。
  // 放在最前面也顺势兑现了 §9.1 的排序（输入行的 `note_index` 当 0，排在这一批笔记之前）。
  const skippedRow: LedgerInputRow | null =
    skipped.length === 0
      ? null
      : buildInputEntry({
          ts: stamp,
          inputId,
          sourceHash: ingested.hash,
          model: options.model,
          promptVersion: options.promptVersion,
          outcome: 'skipped',
          reason: `用户跳过了 ${String(skipped.length)} 条（草稿都在 draft/ 里）。`,
          draftTotal: notes.length,
          skippedTotal: skipped.length,
        });

  if (dryRun) {
    if (skippedRow !== null) {
      log(`  （--dry-run）本来会往台账里记一行：skipped —— ${skippedRow.reason}`);
    }
  } else {
    appendEntries(options.paths, skippedRow === null ? entries : [skippedRow, ...entries]);
  }

  log('');
  if (dryRun) {
    log(`--dry-run：本来会写入 ${String(accepted.length)} 条笔记，实际上一个文件都没有写。`);
    return EXIT.OK;
  }
  log(
    `✓ 写入 ${String(accepted.length)} 条笔记` +
      (skipped.length === 0
        ? '。'
        : `，跳过 ${String(skipped.length)} 条（草稿还在 draft/ 里，之后可以用 reprocess 重新处理）。`),
  );
  log(`  台账：${vaultRelativePath(options.paths, options.paths.ledgerFile)}`);
  return EXIT.OK;
}

/* ------------------------------------------------------------------ *
 * 时间戳
 * ------------------------------------------------------------------ */

/**
 * ISO 8601，带本机时区偏移，例如 `2026-09-28T21:31:26+08:00`。
 *
 * 不用 `date.toISOString()`：它给的是 UTC（`2026-09-28T13:31:26.000Z`），
 * 用户拿这个时间去找「我什么时候记的这条」还得自己心算时差。frontmatter 的
 * `created` 是给人看的字段，按本地时间写才有用（契约里的例子也是带偏移的形式）。
 *
 * 秒精度就够：这个字段回答的是「哪天记的」，不是性能分析。
 */
export function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  // 先把 UTC 时刻平移一个偏移量，再按 UTC 打印——得到的正好是本机的墙上时间。
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${hours}:${minutes}`;
}

/* ------------------------------------------------------------------ *
 * 内部实现
 * ------------------------------------------------------------------ */

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function requirePrompter(prompter: AddPrompter | undefined): AddPrompter {
  if (prompter === undefined) {
    // 只有「没用 --yes 又没人负责提问」会走到这里，那是调用方的 bug，不是用户的问题。
    throw new Error('没有预览交互实现：不用 --yes 时必须提供 prompter。');
  }
  return prompter;
}

/** 把草稿里所有存疑项摊平（与 `core/reprocess.ts` 的同名导出是同一份实现）。 */
interface ResolvedDraft {
  draft: NoteDraft;
  /** 模型给出的存疑项总数。 */
  total: number;
  /** 最终会出现在笔记里的数量（保留 + 改写）。 */
  kept: number;
  /**
   * 这次问出来的**非 keep** 裁定（`d` / `e`）。要写进
   * `resolutions/<input_id>.json`，否则下次 `reprocess` 重渲染时用户当年改的
   * 东西就丢了。`keep` 不记：它是默认值。
   */
  rulings: UncertainRuling[];
}

/**
 * 逐条问存疑项该怎么办，返回**新的**草稿。
 *
 * 不就地改草稿，是因为那份草稿已经写进 `draft/<input_id>.json` 了：磁盘上那份是
 * 「模型到底回了什么」的证据，内存里这份才是「用户最终要什么」的成品，两者
 * 从头就该是两个对象，免得哪天顺手一改就把证据也改了。
 *
 * 顺带把用户做的 `d`/`e` 裁定收集起来（返回值里的 `rulings`）：`draft/` 不许改，
 * 所以裁定得另存一份文件——`resolutions/<input_id>.json`（契约 §12.4）。
 */
async function resolveUncertainties(
  draft: NoteDraft,
  noteIndex: number,
  noteTotal: number,
  prompter: AddPrompter,
): Promise<ResolvedDraft> {
  const all = uncertainItems(draft);
  if (all.length === 0) return { draft, total: 0, kept: 0, rulings: [] };

  const removed = new Set<UncertainItem>();
  const edits = new Map<UncertainItem, string>();
  const rulings: UncertainRuling[] = [];
  let kept = 0;

  for (let index = 0; index < all.length; index += 1) {
    const item = all[index];
    if (item === undefined) continue;
    const resolution = await prompter.resolveUncertain({
      noteIndex,
      noteTotal,
      index: index + 1,
      total: all.length,
      item,
    });

    if (resolution.action === 'drop') {
      removed.add(item);
      rulings.push({ item_index: index + 1, text: item.text, action: 'drop' });
      continue;
    }
    if (resolution.action === 'edit') {
      edits.set(item, resolution.text);
      rulings.push({
        item_index: index + 1,
        text: item.text,
        action: 'edit',
        resolution: resolution.text,
      });
    }
    // 空文本的条目渲染器不会输出（`renderUncertain` 会跳过），所以它不该计入 kept。
    if (item.text.trim() !== '') kept += 1;
  }

  const blocks = draft.blocks.map((block): Block => {
    if (block.type !== 'uncertain') return block;
    return {
      ...block,
      items: block.items
        .filter((item) => !removed.has(item))
        .map((item) => {
          const text = edits.get(item);
          return text === undefined ? item : { ...item, resolution: text };
        }),
    };
  });

  return { draft: { ...draft, blocks }, total: all.length, kept, rulings };
}

/**
 * 把这次录入里用户对存疑项做的裁定写到 `resolutions/<input_id>.json`。
 *
 * 三条时机上的规矩，都是有意为之：
 *
 * 1. **在预览循环之后、撞名守卫之前写。** 这个顺序保证「笔记文件在 ⇒ 重放需要的
 *    裁定也在」；反过来的话，撞名整批不写、裁定却已经落盘，下次 `reprocess` 会拿
 *    一份没有对应笔记的裁定去重渲染。
 * 2. **一条非 keep 都没有时不写文件。** `keep` 是默认值，写一份全是空话的文件
 *    只会让 `resolutions/` 变得需要逐个解释。
 * 3. **`--dry-run` 不写。** 契约 §7：`--dry-run` 一个字节都不写。
 */
function saveRulings(
  options: AddOptions,
  inputId: string,
  rulings: readonly NoteRulings[],
  now: () => Date,
  log: (message: string) => void,
): void {
  const withItems = rulings.filter((note) => note.items.length > 0);
  if (withItems.length === 0) return;

  if (options.dryRun === true) {
    log('（--dry-run）本来会把这次对存疑项的裁定记进 resolutions/。');
    return;
  }

  ensureVaultLayout(options.paths);
  const filePath = writeResolutions(options.paths, inputId, {
    input_id: inputId,
    ts: formatTimestamp(now()),
    notes: withItems,
  });
  log(`存疑项的裁定已记下：${vaultRelativePath(options.paths, filePath)}`);
}

/**
 * 写入前的重名守卫。
 *
 * 两件事都要拦：
 *   1. **这一批内部**撞名——同一次输入里两条标题相同的笔记，`id8` 必然相同，
 *      后写的会静默覆盖先写的。这是必须现在就堵上的缺口（R4：丢内容）。
 *   2. **磁盘上已经有同名文件**——`--force` 重跑时旧笔记必须原样留着（契约 6.5），
 *      覆盖掉就等于把「重新处理」变成了「毁掉上一次的结果」。
 *
 * 拦下来的方式是**整批不写**，而不是「跳过冲突的那两条继续写」。理由：半写成功的批次
 * 会留下一个很难解释的状态（有的笔记在、有的不在、台账还缺了几行），而原文和草稿
 * 本来就已经安全落盘了——一条笔记都不会丢，重跑一次的成本只是再等一次模型。
 */
/**
 * 写入前的重名守卫需要知道的最小信息。
 *
 * 收窄成这个接口而不是直接收 `DecidedNote`，是为了让 `reprocess` 也能用同一个守卫：
 * 两条路算出来的「一篇将要落盘的笔记」只有标题和 id 是共通的，别的字段各不相同。
 */
interface SafeTargetNote {
  /** 0 起的下标，只用来拼报错信息。 */
  index: number;
  noteId: string;
  draft: NoteDraft;
}

function assertSafeTargets(
  paths: VaultPaths,
  notes: readonly SafeTargetNote[],
  allowOverwrite: ReadonlySet<string> = new Set<string>(),
): void {
  const seen = new Map<string, SafeTargetNote>();
  const clashes: string[] = [];

  for (const note of notes) {
    const fileName = noteFileName(note.draft.title, note.noteId);
    // 比较用**大小写无关**的键：Windows 和 macOS 的文件系统默认不区分大小写，而 slug
    // 保留标题原本的大小写——「示例 A」和「示例 a」在那两套系统上就是同一个文件。
    // 在区分大小写的系统上这会多拦一种情况，而多拦一次只是让用户拆开输入；少拦一次
    // 却是静默覆盖，正是要防的事。
    const key = fileName.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      clashes.push(
        `第 ${String(previous.index + 1)} 条「${previous.draft.title}」与` +
          `第 ${String(note.index + 1)} 条「${note.draft.title}」` +
          `会写到同一个文件：${fileName}`,
      );
      continue;
    }
    seen.set(key, note);

    if (fileExists(noteFilePath(paths, note.draft.title, note.noteId))) {
      // 重处理从来就是要覆盖既有文件；白名单里是「本次要重写的这几篇自己的目标路径」。
      // 白名单之外的文件存在照样整批拒绝——D29「先算全部目标文件名，有冲突就一个字都不写」
      // 的立场没有动摇：护住别人的笔记，只放开自己名下这几篇。
      if (allowOverwrite.has(key)) continue;
      clashes.push(`知识库里已经有这个文件了：${fileName}`);
    }
  }

  if (clashes.length === 0) return;

  throw new UnsafeWriteError(
    `有 ${String(clashes.length)} 处笔记要在同一个文件上碰头。为了避免互相覆盖，这次一条都没有写入：\n` +
      clashes.map((clash) => `  · ${clash}`).join('\n') +
      '\n\n  起因：文件名是「标题 + 笔记 id 前 8 位」，而 id 的前 8 位是时间戳——\n' +
      '  同一次输入拆出来的笔记天生共享它，所以标题一样就会撞名。\n' +
      '  原文和全部草稿都还在，一条笔记都没丢。把这两段内容拆成两次输入再跑一次就好。',
  );
}

/** 一条笔记将会写到哪里（相对知识库根），预览与 `--dry-run` 都用它。 */
function targetRelative(paths: VaultPaths, note: DecidedNote): string {
  return vaultRelativePath(paths, noteFilePath(paths, note.draft.title, note.noteId));
}

interface SceneParams {
  inputId: string;
  sourceHash: string;
  error: ValidationError;
  log: (message: string) => void;
  dryRun: boolean;
}

/** 校验失败时把现场写进 `quarantine/`（退出码 3 的那一半承诺）。 */
function saveValidationScene(options: AddOptions, scene: SceneParams): void {
  if (scene.dryRun) {
    scene.log('（--dry-run）本来会把模型的原始产出存进 quarantine/。');
    return;
  }
  ensureVaultLayout(options.paths);
  const filePath = writeQuarantine(options.paths, scene.inputId, {
    input_id: scene.inputId,
    source_hash: scene.sourceHash,
    model: options.model,
    prompt_version: options.promptVersion,
    attempts: scene.error.attempts,
    // 每一次的原文都留着：第一次和第三次的差别往往就是全部线索。
    raw_outputs: [...scene.error.rawOutputs],
    message: scene.error.message,
  });
  scene.log(`现场已保存：${vaultRelativePath(options.paths, filePath)}`);
}

interface EntryParams {
  ts: string;
  inputId: string;
  noteId: string;
  index: number;
  total: number;
  sourceHash: string;
  notePath: string;
  draft: NoteDraft;
  status: NoteStatus;
  model: string;
  promptVersion: string;
  outcome: AnalyzeOutcome;
  uncertainTotal: number;
  uncertainKept: number;
}

/** 拼一条台账记录（契约第 9 节）。字段名是磁盘格式，不能顺手改成 camelCase。 */
function buildLedgerEntry(params: EntryParams): LedgerNoteRow {
  return {
    ts: params.ts,
    input_id: params.inputId,
    id: params.noteId,
    // 序号从 1 开始，`note_index` 是给用户看的（「12 条里的第 3 条」）。
    note_index: params.index + 1,
    note_total: params.total,
    source_hash: params.sourceHash,
    note_path: params.notePath,
    title: params.draft.title,
    tags: [...params.draft.tags],
    status: params.status,
    model: params.model,
    prompt_version: params.promptVersion,
    // 供应商没返回用量时记 0，而不是留空：契约第 9 节把这两个字段定义为数字。
    tokens_in: params.outcome.usage.inputTokens ?? 0,
    tokens_out: params.outcome.usage.outputTokens ?? 0,
    latency_ms: params.outcome.latencyMs,
    uncertain_total: params.uncertainTotal,
    uncertain_kept: params.uncertainKept,
    outcome: 'ok',
  };
}

interface InputEntryParams {
  ts: string;
  inputId: string;
  sourceHash: string;
  model: string;
  promptVersion: string;
  outcome: LedgerRecordableOutcome;
  reason: string;
  draftTotal: number;
  skippedTotal?: number;
}

/**
 * 拼一条「输入行」（契约 §9.3）：**一行 = 一次走到「原文已落盘」的输入**。
 *
 * 它和笔记行的分工是：笔记行记「产出了什么」，输入行记「这次输入最后怎么了」。
 * 没有 `id`/`note_path`/`note_index` 这些字段——一次校验失败或用户取消的输入
 * 根本没有笔记，硬填占位值等于在磁盘上造假（契约 §9 明写「不许填占位值」）。
 */
function buildInputEntry(params: InputEntryParams): LedgerInputRow {
  return {
    ts: params.ts,
    input_id: params.inputId,
    source_hash: params.sourceHash,
    model: params.model,
    prompt_version: params.promptVersion,
    outcome: params.outcome,
    reason: params.reason,
    draft_total: params.draftTotal,
    ...(params.skippedTotal === undefined ? {} : { skipped_total: params.skippedTotal }),
  };
}

/** `reason` 的长度上限（字符）：够说清「哪个服务、什么状态码」，又不会把整个错误页抄进台账。 */
const REASON_MAX = 200;

/**
 * 把一段可能很长、很多行的错误信息压成台账里的 `reason`。
 *
 * 先抹密钥、再压成一行、最后截断——顺序不能反：先截断会把 `sk-…` 切掉一半，
 * 让「看起来已经不像密钥」的残片留在磁盘上。
 *
 * 为什么非要单行：JSONL 里嵌 `\n` 是合法的，但用户 `type ledger.jsonl` 的时候
 * 一条记录会散成好几行，看不出哪几行属于同一条。`LlmError` 的消息本身就是四五行的中文。
 */
function reasonText(message: string): string {
  const collapsed = redactSecrets(message).replace(/\s+/g, ' ').trim();
  return collapsed.length <= REASON_MAX ? collapsed : `${collapsed.slice(0, REASON_MAX)}…`;
}

/**
 * 抹掉可能混进错误信息里的密钥。
 *
 * `io/llm.ts` 今天**不会**把 API Key 放进任何消息（它只放 url、状态码和对方说的话，
 * 见那里的注释），所以这个函数现在什么都不会匹配到。留着它是因为台账是一份要给用户看、
 * 甚至可能被复制出去的文件：将来某次「顺手把 authorization 头拼进错误信息」的改动，
 * 不该让密钥躺在磁盘上。
 */
function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐去]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[已隐去的 Key]');
}

/* ------------------------------------------------------------------ *
 * `reprocess` 的编排（T13）
 * ------------------------------------------------------------------ */

/**
 * 重渲染的对象。两个来源（`draft/<input_id>.json` 与盘上单篇笔记）在这里汇成一种形状，
 * 之后共用同一段渲染、预览、写盘、重放裁定的代码。
 */
interface ReReprocessGroup {
  kind: 'input' | 'note';
  inputId: string;
  sourceHash: string;
  notes: readonly NoteDraft[];
  ledgerModel: string | undefined;
  ledgerPromptVersion: string | undefined;
  fallbackModel: string | undefined;
  fallbackPromptVersion: string | undefined;
  /**
   * `--note` 用：只重渲染这些标题的那几条。
   *
   * **源头仍然是整份草稿**——`--note` 只是「选中哪一篇」的过滤器，不是「拿笔记正文当草稿」。
   * 后者会把 steps/params/concept 压成一段纯文本，重渲染等于毁掉笔记结构。保留整份草稿
   * 还有个硬理由：裁定文件里的 `note_index` 是**草稿里**的下标，过滤发生在配对之后，
   * 坐标才不会错位。
   */
  onlyTitles?: ReadonlySet<string>;
}

export async function runReprocess(options: RunReprocessOptions): Promise<ExitCode> {
  const log = options.log ?? writeLine;
  const dryRun = options.dryRun === true;
  const yes = options.yes === true;
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? newUlid;
  const stamp = formatTimestamp(now());
  const paths = options.paths;

  if (options.reanalyze === true) {
    if (options.inputId === undefined) {
      throw new UsageError('`--reanalyze` 要配合 `--input <input_id>` 使用。');
    }
    return await runReanalysis(options, options.inputId, log, now, newId);
  }

  const group: ReReprocessGroup = await loadReReprocessGroup(options, log);

  // 元数据的来源优先级（契约 §12）：台账优先，既有笔记次选，都缺就退出码 3。
  // `createdFallback` 只在「草稿有、盘上没这回事」时用得到（那就是新造一篇笔记）。
  const mapped = mapDraftNotes({
    inputId: group.inputId,
    notes: group.notes,
    existing: readNoteSummaries(paths).map((summary) => ({
      relativePath: summary.relativePath,
      frontmatter: summary.frontmatter,
    })),
    sourceHash: group.sourceHash,
    ...(group.ledgerModel === undefined ? {} : { ledgerModel: group.ledgerModel }),
    ...(group.ledgerPromptVersion === undefined
      ? {}
      : { ledgerPromptVersion: group.ledgerPromptVersion }),
    ...(group.fallbackModel === undefined ? {} : { fallbackModel: group.fallbackModel }),
    ...(group.fallbackPromptVersion === undefined
      ? {}
      : { fallbackPromptVersion: group.fallbackPromptVersion }),
    createdFallback: stamp,
    statusForNew: yes ? 'inbox' : 'processed',
    newId,
  });

  if (!mapped.ok) {
    log('');
    log('✗ 这份草稿没法重处理：');
    for (const problem of mapped.problems) log(`  · ${problem}`);
    return EXIT.VALIDATION;
  }
  for (const warning of mapped.warnings) log(`⚠ ${warning.message}`);

  // `--note` 只重渲染选中的那几篇；配对发生在过滤之前，所以 note_index 仍是草稿里的下标。
  const plan = mapped;
  const selected =
    group.onlyTitles === undefined
      ? plan.targets
      : plan.targets.filter((target) => group.onlyTitles?.has(target.draft.title) === true);
  if (selected.length === 0) {
    log('');
    log(`✗ 这篇笔记的标题在草稿（${group.inputId}）里找不到对应的一条，没法重渲染。`);
    log('  草稿可能被手工改过别名。要重新分析请用：reprocess --input ' + group.inputId + ' --reanalyze');
    return EXIT.VALIDATION;
  }
  const orphans =
    group.onlyTitles === undefined
      ? { draftNotes: plan.orphanDraftNotes, existing: plan.orphanExisting }
      : { draftNotes: 0, existing: 0 };
  if (plan.targets.length === 0) {
    log('');
    log(`这次输入（${group.inputId}）的草稿里一条笔记都没有，没有东西可以重渲染。`);
    return EXIT.OK;
  }

  const problems = checkPlanTargets(plan);
  if (problems.length > 0) {
    log('');
    log('✗ 这份草稿拿不到写笔记必需的元数据：');
    for (const problem of problems) log(`  · ${problem}`);
    log('  要重新分析请用：reprocess --input ' + group.inputId + ' --reanalyze');
    return EXIT.VALIDATION;
  }

  // 裁定的重放（契约 §12）：文件不在就是「用户没改过任何存疑项」，一律按 keep。
  const rulings = readResolutionsFor(paths, group.inputId, log);

  log('');
  log(
    `重渲染这次输入（${group.inputId}）：共 ${String(selected.length)} 条，` +
      `其中 ${String(selected.filter((target) => target.existing).length)} 条对应盘上已有的笔记、` +
      `${String(orphans.draftNotes)} 条会新建。`,
  );
  if (orphans.draftNotes > 0) {
    log(
      `  其中 ${String(orphans.draftNotes)} 条在盘上找不到同标题的笔记` +
        '（当年被跳过、或笔记被手工删过）——它们会以新 id 写成新笔记。',
    );
  }
  if (orphans.existing > 0) {
    log(
      `  另有 ${String(orphans.existing)} 篇笔记在这份草稿里找不到对应标题，` +
        '这次不会动它们。',
    );
  }

  const prompter =
    yes || dryRun
      ? null
      : requireReprocessPrompter(options.prompter);

  const accepted: PlannedNote[] = [];
  const acceptedMarkdown = new Map<number, string>();
  const acceptedStatus = new Map<number, NoteStatus>();
  const newRulings: NoteRulings[] = [];
  const unchanged: PlannedNote[] = [];
  let acceptAll = yes;
  let quit = false;
  let displayIndex = 0;

  log('');
  for (const target of selected) {
    displayIndex += 1;
    const sourceRulings = rulings.get(target.index) ?? null;

    // 先把用户当年在预览里做的裁定重放上去。默认路径**不重新问第二遍**（判断 5）：
    // 有裁定文件就重放，没有就一律 keep（渲染成「## 待确认」）。
    let draft = target.draft;
    if (sourceRulings !== null) {
      const applied = replayRulings(target.draft, target.index, sourceRulings, group.inputId);
      for (const warning of applied.warnings) log(`⚠ ${warning}`);
      draft = applied.draft;
    }

    // 先按「盘上那篇的 updated」渲染一次：内容是否真的变了，就是拿它与盘上的字节比。
    const current = renderPlanned(
      { ...target, draft },
      { updated: target.existingUpdated ?? stamp },
    );

    const changed =
      target.existing && target.existingPath !== null
        ? readText(join(paths.root, target.existingPath)) !== current.markdown
        : true;

    let kept = uncertainItems(draft).length;
    let decidedHere = false;

    if (prompter !== null) {
      const resolved = await resolveUncertainties(
        draft,
        target.index - 1,
        selected.length,
        prompter,
      );
      draft = resolved.draft;
      kept = resolved.kept;
      if (resolved.rulings.length > 0) {
        newRulings.push({ note_index: target.index, items: resolved.rulings });
        decidedHere = true;
      }
    }
    void kept;

    // 内容一个字节都没变、而且用户没在预览里改过存疑项时，连 updated 都不动（真幂等：
    // 连跑两次，第二次零写入）。判定用的是**没重问存疑项之前**的渲染结果，因为
    // 「重问之后」的 markdown 只可能因为用户的裁定而变，那属于「内容真变了」。
    if (!changed && !decidedHere) {
      unchanged.push({ ...target, draft });
      continue;
    }

    // 内容真的要写了：`updated` 刷成现在（`created` 保持原值）。
    const markdown = renderPlanned(
      { ...target, draft },
      { updated: changed || decidedHere ? stamp : (target.existingUpdated ?? stamp) },
    ).markdown;

    if (prompter !== null) {
      const decision = await prompter.confirmNote({
        // 预览里的 1/13 是给人看的序号，不是草稿下标；`--note` 只选中一篇时它就是 1/1。
        index: displayIndex,
        total: selected.length,
        draft,
        markdown,
        existing: target.existing,
        existingPath: target.existingPath,
        changed,
      });
      if (decision === 'quit') {
        quit = true;
        break;
      }
      if (decision === 'accept-all') acceptAll = true;
      if (decision === 'skip' && !acceptAll) {
        log(`  · 已跳过：${target.draft.title}`);
        continue;
      }
    }
    void acceptAll;

    accepted.push({ ...target, draft });
    acceptedMarkdown.set(target.index, markdown);
    acceptedStatus.set(target.index, target.existing ? 'processed' : target.status);
  }

  if (quit) {
    log('');
    log('已取消：这一批一篇笔记都没有重写（包括前面已经确认过的）。');
    log('  盘上的笔记一个字节都没有动。');
    options.afterCancel?.();
    return EXIT.OK;
  }

  if (unchanged.length > 0) {
    log('');
    log(`未变化 ${String(unchanged.length)} 条（内容与盘上逐字节相同，一个字节都不会写）：`);
    for (const target of unchanged) log(`  · ${target.draft.title}`);
  }

  if (accepted.length === 0) {
    log('');
    log(`✓ 没有需要改写的笔记：${String(unchanged.length)} 条全部未变化，0 个文件被改写。`);
    log('  台账没有改动；要看刷新后的索引请运行 learnmate rebuild-index');
    return EXIT.OK;
  }

  // 撞名守卫：只有「本次要改写的既有一篇」自己的目标路径才进白名单。新建的笔记
  // 不许覆盖任何文件——它的文件名是新算出来的，落在一个已经存在的文件上就说明算错了，
  // 那种情况必须整批拒绝，而不是顺手盖掉别人的笔记。
  const overwrite = new Set<string>();
  for (const target of accepted) {
    if (!target.existing) continue;
    overwrite.add(noteFileName(target.draft.title, target.noteId).toLowerCase());
  }
  try {
    assertSafeTargets(paths, accepted, overwrite);
  } catch (error) {
    if (error instanceof UnsafeWriteError) log(`\n✗ ${error.message}`);
    throw error;
  }

  // 第一次真的要把字节写进去（`--dry-run` 不会走到这里）。
  options.beforeWrite?.();

  const written: PlannedNote[] = [];
  const created: PlannedNote[] = [];
  log('');
  for (const target of accepted) {
    const markdown = acceptedMarkdown.get(target.index) ?? '';
    if (dryRun) {
      log(`  （--dry-run）会写入：${noteFileName(target.draft.title, target.noteId)}`);
      written.push(target);
      if (!target.existing) created.push(target);
      continue;
    }
    const filePath = writeNote(paths, target.draft.title, target.noteId, markdown);
    log(`  ✓ ${target.draft.title} → ${vaultRelativePath(paths, filePath)}`);
    written.push(target);
    if (!target.existing) created.push(target);
  }

  // 只有用户这次在预览里做的裁定才落盘；`--yes` / `--dry-run` 一条都不产生。
  if (newRulings.length > 0 && !dryRun) {
    const filePath = writeResolutions(paths, group.inputId, {
      input_id: group.inputId,
      ts: stamp,
      notes: newRulings,
    });
    log(`  存疑项的裁定已记下：${vaultRelativePath(paths, filePath)}`);
  }

  log('');
  if (dryRun) {
    log(
      `--dry-run：本来会改写 ${String(written.length)} 篇笔记` +
        `（其中新建 ${String(created.length)} 篇），实际上一个文件都没有写。`,
    );
    return EXIT.OK;
  }
  log(
    `✓ 重渲染完成：改写 ${String(written.length)} 篇` +
      (created.length === 0 ? '。' : `，其中新建 ${String(created.length)} 篇。`),
  );
  // 默认重渲染**一行台账都不写**：台账记的是「每次输入的结局」，重渲染不改变
  // 结局；而刷新既有的派生字段（title/tags/status/note_path）本来就是 rebuild-index 的活。
  log('  台账没有改动；要看刷新后的索引请运行 learnmate rebuild-index');
  return EXIT.OK;
}

/**
 * 算出这次重渲染的「源头」。
 *
 * 不管从哪个选项进来，源头都必须是**草稿**（`draft/<input_id>.json`）：草稿才记着
 * steps / params / concept 这些结构，盘上的笔记只是这些结构渲染出来的样子。
 * `--note` 只是「选中哪一篇」的过滤器（见 `ReReprocessGroup.onlyTitles`）。
 */
async function loadReReprocessGroup(
  options: RunReprocessOptions,
  log: (message: string) => void,
): Promise<ReReprocessGroup> {
  const paths = options.paths;
  if (options.noteId !== undefined) {
    return loadSingleNote(paths, options.noteId, log);
  }
  if (options.inputId !== undefined) {
    return loadDraftGroup(paths, options.inputId, log);
  }
  throw new UsageError('要重处理什么？给 --input <input_id>、--note <笔记 id> 或 --source <指纹> 其中之一。');
}

/** 从 `draft/<input_id>.json` 读一份草稿，顺带把台账里的元数据取回来。 */
function loadDraftGroup(
  paths: VaultPaths,
  inputId: string,
  log: (message: string) => void,
): ReReprocessGroup {
  const draftFile = draftFilePath(paths, inputId);
  if (!fileExists(draftFile)) {
    throw new UsageError(
      `${inputId} 这次输入没有留下草稿（找不到 ${vaultRelativePath(paths, draftFile)}），` +
        '所以没有东西可以重渲染。\n' +
        '  只能重新分析：reprocess --input ' +
        inputId +
        ' --reanalyze（要 API Key、要花一次模型调用）。',
    );
  }
  const raw = readText(draftFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(`${vaultRelativePath(paths, draftFile)} 不是合法的 JSON。`, {
      rawOutput: raw,
      attempts: 1,
    });
  }
  const notes = extractDraftNotes(parsed);
  if (notes === null) {
    throw new ValidationError(
      `${vaultRelativePath(paths, draftFile)} 的内容不是一份分析结果（缺 notes 数组）。`,
      { rawOutput: raw, attempts: 1 },
    );
  }

  // 台账里这次输入的任何一行都能给出 source_hash / model / prompt_version——它们是
  // **一次输入**的属性，同一 input_id 的每一行本来就相同（契约 §9）。
  const entries = readLedger(paths).entries.filter((entry) => entry.input_id === inputId);
  const first = entries[0];
  if (first === undefined) {
    log(
      `  注意：台账里没有 ${inputId} 的记录，元数据改从盘上的既有笔记里找` +
        '（找不到就报错，绝不猜）。',
    );
  }

  return {
    kind: 'input',
    inputId,
    sourceHash: first?.source_hash ?? '',
    notes,
    ledgerModel: first?.model,
    ledgerPromptVersion: first?.prompt_version,
    fallbackModel: undefined,
    fallbackPromptVersion: undefined,
  };
}

/**
 * `--note`：先在盘上找到这一篇，再回到**它那份草稿**里去重渲染它。
 *
 * 为什么不拿笔记正文当草稿：笔记正文是渲染结果，steps / params / concept 的结构已经
 * 变成 Markdown 了。拿它当草稿再渲染一次，等于把这些结构压成一段纯文本——那不是
 * 「重渲染」，那是毁掉笔记。草稿才是结构所在，而 `frontmatter.input_id` 就是草稿的钥匙
 * （D20 当初把 input_id 写进 frontmatter，正是为了今天这一手）。
 */
function loadSingleNote(
  paths: VaultPaths,
  handle: string,
  log: (message: string) => void,
): ReReprocessGroup {
  const summaries = readNoteSummaries(paths);
  const matches = summaries.filter((summary) => summary.frontmatter?.id === handle);
  let picked = matches.length === 1 ? matches[0] : undefined;
  if (matches.length === 0) {
    // 也允许用笔记文件名（不含 .md）来找——`list` 命令显示的就是它。
    const byFile = summaries.filter(
      (summary) => summary.relativePath.split('/').at(-1)?.replace(/\.md$/u, '') === handle,
    );
    if (byFile.length === 0) {
      throw new UsageError(
        `知识库里没有这篇笔记：${handle}\n` +
          '  --note 收完整的 26 位笔记 id（或者不含 .md 的文件名）。用 learnmate list 看有哪些。',
      );
    }
    if (byFile.length > 1) {
      throw new UsageError(
        `${handle} 对上了 ${String(byFile.length)} 个文件，没法判断是哪一篇：\n` +
          byFile.map((match) => `  · ${match.relativePath}`).join('\n') +
          '\n  请用完整的 26 位笔记 id。',
      );
    }
    picked = byFile[0];
  } else if (matches.length > 1) {
    throw new UsageError(
      `${handle} 对上了 ${String(matches.length)} 篇笔记，没法判断是哪一篇：\n` +
        matches.map((match) => `  · ${match.relativePath}`).join('\n') +
        '\n  请用完整的 26 位笔记 id。',
    );
  }
  const summary = picked;
  if (summary === undefined) {
    throw new UsageError(`知识库里没有这篇笔记：${handle}`);
  }
  const frontmatter = summary.frontmatter;
  if (frontmatter === null) {
    throw new UsageError(
      `这篇笔记的 frontmatter 读不出来，没法重渲染：${summary.relativePath}`,
    );
  }
  const inputId = frontmatter.input_id;
  if (inputId === undefined || inputId === '') {
    throw new UsageError(
      `这篇笔记的 frontmatter 里没有 input_id，找不到它当初那份草稿：${summary.relativePath}\n` +
        '  没有草稿就没有可重渲染的结构，只能加 --reanalyze 重新分析（要 API Key）。',
    );
  }
  // 源头是整份草稿；`onlyTitles` 负责把范围收回到这一篇。
  const group = loadDraftGroup(paths, inputId, log);
  return { ...group, kind: 'note', onlyTitles: new Set([frontmatter.title]) };
}

/**
 * `--reanalyze`：把 `raw/<旧 input_id>.txt` 当成一次全新的输入再跑一遍 `add`。
 *
 * 复用 `runAdd` 而不是另写一套：分析、校验、重试、预览、存疑项、台账八个出口这些
 * 行为必须与 `add` 一模一样，抄一份出来的那天就是两者开始分叉的那天。差别只有三处：
 * 跳过查重（用户明确要求重来的）、产出新 input_id（旧的是历史，一律不动）、
 * 以及在写新笔记之前把旧笔记搬进 `trash/`。
 */
async function runReanalysis(
  options: RunReprocessOptions,
  oldInputId: string,
  log: (message: string) => void,
  now: () => Date,
  newId: () => string,
): Promise<ExitCode> {
  const paths = options.paths;
  let stored: { normalized: string; hash: string; charCount: number };
  try {
    const raw = readRaw(paths, oldInputId);
    stored = { normalized: raw, hash: fingerprint(raw), charCount: countInputCharacters(raw) };
  } catch {
    throw new UsageError(
      `${oldInputId} 这次输入没有留下原文（找不到 raw/${oldInputId}.txt），没法重新分析。\n` +
        '  原文是唯一不可再生的东西；没有它就只能重新录入一遍。',
    );
  }

  if (options.template === undefined || options.model === undefined || options.chat === undefined) {
    throw new UsageError('`--reanalyze` 需要提示词模板、模型名和对话能力（由命令层准备好）。');
  }
  const promptVersion = options.promptVersion ?? 'analyze.v2';

  // 搬 / 放旧笔记：`beforeWrite` 在「用户已经确认、且不会再有整批拒绝」之后跑，
  // 所以 q 取消、撞名、--dry-run 三种情况下旧笔记都还在原地。搬完之前一条新笔记都不写。
  const oldNotes = readNoteSummaries(paths)
    .filter((summary) => summary.frontmatter?.input_id === oldInputId)
    .map((summary) => summary.relativePath);
  const moved: string[] = [];
  const moveOldNotes = (): void => {
    if (options.dryRun === true || oldNotes.length === 0) return;
    for (const relativePath of oldNotes) {
      const fileName = relativePath.split('/').at(-1);
      if (fileName === undefined) continue;
      const target = moveNoteToTrash(paths, fileName);
      moved.push(relativePath);
      log(`  旧笔记已移入回收站：${vaultRelativePath(paths, target)}`);
    }
  };
  const restoreOldNotes = (): void => {
    for (const relativePath of moved) {
      const fileName = relativePath.split('/').at(-1);
      if (fileName === undefined) continue;
      try {
        moveNoteToTrash(paths, fileName);
      } catch {
        // 放回去失败不该盖掉原本的取消/撞名信息；回收站里的文件还在，用户能自己挪。
      }
    }
    moved.length = 0;
  };

  log(
    `重新分析 ${oldInputId} 的原文（${String(oldNotes.length)} 篇旧笔记` +
      (options.dryRun === true ? '，--dry-run 不会动它们）。' : '，确认之后会移入回收站）。'),
  );

  return await runAdd(stored.normalized, {
    paths,
    template: options.template,
    model: options.model,
    promptVersion,
    chat: options.chat,
    maxInputChars: options.maxInputChars ?? 20_000,
    // 旧的 raw/draft/台账行一律不动（draft/ 是 write-once）；新的会写在新 input_id 下。
    // raw/ 只存正文、不存源文件名，所以这里**没有** sourceRef —— 这是与
    // `add --force` 的唯一信息损失，已经写进契约 §12。
    force: true,
    ingestOverride: stored,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.prompter === undefined ? {} : { prompter: options.prompter }),
    log,
    now,
    newId,
    beforeWrite: moveOldNotes,
    afterCancel: restoreOldNotes,
  });
}

/** 一份草稿里的 `notes`；形状不对返回 null（调用方负责报错）。 */
function extractDraftNotes(value: unknown): NoteDraft[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const notes = (value as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return null;
  const drafts: NoteDraft[] = [];
  for (const note of notes) {
    if (typeof note !== 'object' || note === null) return null;
    if (typeof (note as { title?: unknown }).title !== 'string') return null;
    drafts.push(note as NoteDraft);
  }
  return drafts;
}

/**
 * 读 `resolutions/<input_id>.json` 并按 `note_index` 分好。
 *
 * 三种情况都必须能继续：文件不在（用户没改过任何存疑项——这是常态）、JSON 坏了、
 * 形状不合法。后两种打一行警告之后按「没有任何裁定」继续，绝不静默也绝不中止：
 * 裁定是**便利**，不是重渲染的前提。
 */
function readResolutionsFor(
  paths: VaultPaths,
  inputId: string,
  log: (message: string) => void,
): Map<number, NoteRulings> {
  const byIndex = new Map<number, NoteRulings>();
  const file = resolutionFilePath(paths, inputId);
  if (!fileExists(file)) return byIndex;

  let raw: string;
  try {
    raw = readResolutions(paths, inputId);
  } catch (error) {
    log(`⚠ 读不出 ${vaultRelativePath(paths, file)}（${describeError(error)}）：按「没有任何裁定」重渲染。`);
    return byIndex;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`⚠ ${vaultRelativePath(paths, file)} 不是合法的 JSON：按「没有任何裁定」重渲染。`);
    return byIndex;
  }

  const result = parseResolutionFile(parsed);
  if (!result.ok) {
    log(`⚠ ${vaultRelativePath(paths, file)} 的形状不合法：`);
    for (const problem of result.problems) log(`    · ${problem}`);
    log('  这次按「没有任何裁定」重渲染；想找回当年的裁定，请检查这个文件。');
    return byIndex;
  }

  for (const note of result.file.notes) {
    if (note.items.length === 0) continue;
    byIndex.set(note.note_index, note);
  }
  return byIndex;
}

/**
 * 按「盘上那篇的 updated」渲染一份计划好的笔记。
 *
 * `status` 直接用 `target.status`：它已经是「既有笔记自己那个」或「新建时该给的那个」
 * （计划层算好的），这里再传一遍只会多一条可能不一致的路径。
 */
function renderPlanned(
  target: PlannedNote,
  overrides: { updated: string },
): { markdown: string; meta: NoteMeta } {
  const meta: NoteMeta = {
    id: target.noteId,
    inputId: target.inputId,
    created: target.created,
    updated: overrides.updated,
    status: target.status,
    sourceHash: target.sourceHash,
    schemaVersion: SCHEMA_VERSION,
    model: target.model,
    promptVersion: target.promptVersion,
    ...(target.sourceRef === undefined ? {} : { sourceRef: target.sourceRef }),
  };
  return { markdown: renderNote(target.draft, meta), meta };
}

/** 时间戳指纹（`sha256:…`）；原文规范化是幂等的，所以重算与当年一致。 */
function fingerprintOf(normalized: string): string {
  return fingerprint(normalized);
}

/** 用户实际写了多少个字：按 Unicode 码点算，规范化补上的末尾换行不算（契约 §5.5）。 */
function countInputCharacters(normalized: string): number {
  const codePoints = [...normalized].length;
  return normalized.endsWith('\n') ? codePoints - 1 : codePoints;
}

function requireReprocessPrompter(prompter: ReprocessPrompter | undefined): ReprocessPrompter {
  if (prompter === undefined) {
    throw new Error('没有预览交互实现：不用 --yes 时必须提供 prompter。');
  }
  return prompter;
}


/* ------------------------------------------------------------------ *
 * `reprocess`：重处理（T13）
 * ------------------------------------------------------------------ */

/** 预览一篇**将要重写**的笔记。与 `add` 的 `NotePreview` 只差「这条笔记叫什么」。 */
export interface ReprocessPreview {
  /** 1 起的序号。 */
  index: number;
  total: number;
  /** 最终会渲染成文件的草稿。 */
  draft: NoteDraft;
  markdown: string;
  /** 盘上已经有这篇（true = 改写，false = 新建）。 */
  existing: boolean;
  /** 盘上那篇的相对路径；新建时为 null。 */
  existingPath: string | null;
  /** 内容是否真的变了（false = 一个字节都不会写）。 */
  changed: boolean;
}

/**
 * 重处理时的提问方。
 *
 * 与 `AddPrompter` 分成两个接口，是因为 `confirmNote` 打印的东西不一样：`add` 的是
 * 「这条笔记你要不要」，这里是「这一篇你要不要覆盖」，用户要能一眼看出自己在覆盖
 * 哪一篇（`vault/` 不在 Git 里，没有版本可回退）。
 */
export interface ReprocessPrompter {
  confirmNote(preview: ReprocessPreview): Promise<NoteDecision>;
  resolveUncertain(preview: UncertainPreview): Promise<UncertainResolution>;
}

export interface RunReprocessOptions {
  paths: VaultPaths;
  /** `--input <input_id>`；与 `noteId` 恰好给一个。 */
  inputId?: string;
  /** `--note <26 位笔记 id>`。 */
  noteId?: string;
  /** `--reanalyze`：把 `raw/<input_id>.txt` 当成一次新输入重新分析（会调模型）。 */
  reanalyze?: boolean;
  /** 跳过全部交互 = 全部接受 + 存疑项按已有裁定重放。 */
  yes?: boolean;
  /** 一个字节都不写。**默认路径也不调模型、不要求 API Key。** */
  dryRun?: boolean;
  /** 预览交互实现。`yes` 为真时不会被调用。 */
  prompter?: ReprocessPrompter;
  log?: (message: string) => void;
  now?: () => Date;
  newId?: () => string;
  /**
   * 第一次真的要把字节写进 `notes/` 之前调一次（`--dry-run` 不调）。
   * `--reanalyze` 用它把同一 input_id 的旧笔记搬进 `trash/`。
   */
  beforeWrite?: () => void;
  /** 这一批一篇都没写（用户 q 取消）时调一次，给 `--reanalyze` 把旧笔记放回去。 */
  afterCancel?: () => void;

  /* ---- 只有 `--reanalyze` 用到 ---- */
  /** 提示词模板正文（`io/prompt.ts` 读好传进来）。 */
  template?: string;
  model?: string;
  promptVersion?: string;
  chat?: ChatFunction;
  maxInputChars?: number;
  maxRetries?: number;
  tags?: readonly string[];
}

