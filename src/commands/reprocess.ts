/**
 * `learnmate reprocess` 的命令层。
 *
 * 它负责三件事：**把「要重处理什么」收敛成一个对象 → 前置检查 → 交给 `pipeline`**。
 *
 * 两个与其他命令不同的地方，都是「重渲染不联网」的直接后果：
 *   1. **默认路径不检查 API Key**——重渲染只是把草稿重新排一遍版，一次模型都不调。
 *      只有 `--reanalyze` 才要求密钥、才去读提示词模板、才建聊天函数。
 *   2. **不指定对象时先打印候选清单**——`input_id` 和笔记 id 都是 26 位大写 ULID，
 *      肉眼分不出谁是谁，与其猜错，不如把候选摊开、返回退出码 2。
 */

import { basename } from 'node:path';
import { loadConfig, requireApiKey } from '../config.js';
import { EXIT, UsageError, type ExitCode } from '../core/errors.js';
import { listCandidates, type ReprocessCandidate } from '../core/reprocess.js';
import { readLedger } from '../io/ledger.js';
import { readNoteSummaries } from '../io/notes.js';
import { readPromptTemplate } from '../io/prompt.js';
import {
  listDraftFiles,
  listResolutionFiles,
  readDraft,
  vaultPaths,
  type VaultPaths,
} from '../io/vault.js';
import { createChatFunction } from '../io/llm.js';
import { runReprocess } from '../pipeline.js';
import { TerminalPrompter } from './add.js';

export interface ReprocessCommandOptions {
  /** `--input <input_id>`：重渲染这一次输入拆出来的全部笔记。 */
  input?: string;
  /** `--note <26 位笔记 id>`：只重渲染这一篇。 */
  note?: string;
  /** `--source <source_hash>`：按指纹反查这次输入（查到多个就报候选）。 */
  source?: string;
  /** `--reanalyze`：重新分析（会调模型、要 API Key）。 */
  reanalyze?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** 配置文件所在目录。测试里指向临时目录；不传就是当前工作目录。 */
  baseDir?: string;
  /** 读配置用的环境变量表。测试里可以给一份空的，验证默认路径不需要 API Key。 */
  env?: NodeJS.ProcessEnv;
}

/** 命令入口。返回退出码；用法/校验/网络错误按既有异常通道往上抛。 */
export async function runReprocessCommand(options: ReprocessCommandOptions): Promise<ExitCode> {
  const config = requireSetup(() => loadConfig({
    ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }));
  if (config === null) return EXIT.USAGE;

  const paths = vaultPaths(config.vaultPath);

  // 对象语法：`--input` / `--note` / `--source` 恰好给一个。一个都不给时把候选摊开，
  // 因为「打错一个字就重写了别的一批笔记」这个风险，比多打一行候选清单贵得多。
  const given = [options.input, options.note, options.source].filter(
    (value) => value !== undefined,
  );
  if (given.length === 0) {
    printCandidates(paths);
    return EXIT.USAGE;
  }
  if (given.length > 1) {
    throw new UsageError(
      '--input、--note、--source 只能给一个——它们都是「重处理什么」的选择器，' +
        '给两个就不知道听谁的了。',
    );
  }

  let inputId = options.input;
  if (options.source !== undefined) {
    const resolved = resolveSource(paths, options.source);
    // `null` = 候选清单已经打印过了，这里只负责把退出码 2 还回去。
    if (resolved === null) return EXIT.USAGE;
    inputId = resolved;
  }

  if (options.reanalyze === true) {
    if (options.note !== undefined) {
      throw new UsageError(
        '`--reanalyze` 不能和 `--note` 一起用：重新分析会产出新的一批笔记，' +
          '「只重做这一篇」在重新分析里没有对应的意思。\n' +
          '  要重新分析整次输入请用：reprocess --input <input_id> --reanalyze',
      );
    }
    if (inputId === undefined) {
      throw new UsageError('`--reanalyze` 要配合 `--input <input_id>` 使用。');
    }

    // 走到这里才需要密钥：默认重渲染一次模型都不调。
    const apiKey = requireSetup(() => requireApiKey(config));
    if (apiKey === null) return EXIT.USAGE;
    const template = requireSetup(() =>
      readPromptTemplate(config.promptPath, config.promptVersion),
    );
    if (template === null) return EXIT.USAGE;
    const chat = createChatFunction({
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      timeoutMs: config.requestTimeoutMs,
    });

    if (options.dryRun === true) {
      process.stdout.write('（--dry-run）会照常调用模型，但一个文件都不会写。\n');
    }

    const prompter = new TerminalPrompter();
    try {
      return await runReprocess({
        paths,
        inputId,
        reanalyze: true,
        template,
        model: config.model,
        promptVersion: config.promptVersion,
        chat,
        maxInputChars: config.maxInputChars,
        yes: options.yes === true,
        dryRun: options.dryRun === true,
        prompter,
      });
    } finally {
      prompter.close();
    }
  }

  // 默认路径：一个字节都不写台账、一次模型都不调，所以也就没有 prompter 需要收尾时
  // 的麻烦——但 `--yes` 之外的交互预览仍然需要它。
  const prompter = new TerminalPrompter();
  try {
    return await runReprocess({
      paths,
      ...(inputId === undefined ? {} : { inputId }),
      ...(options.note === undefined ? {} : { noteId: options.note }),
      yes: options.yes === true,
      dryRun: options.dryRun === true,
      prompter,
    });
  } finally {
    prompter.close();
  }
}

/* ------------------------------------------------------------------ *
 * 前置检查
 * ------------------------------------------------------------------ */

/** 与 `add` 同款的「打印 + 退出码 2」：只翻译 `UsageError`，其余照抛。 */
function requireSetup<T>(step: () => T): T | null {
  try {
    return step();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(`LearnMate 重处理\n\n✗ 检查没通过：${error.message}\n`);
      return null;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * --source：按指纹反查
 * ------------------------------------------------------------------ */

/**
 * 把 `--source <指纹>` 换成 `--input <input_id>`。
 *
 * 规矩与 `show` 一致：**查到一个就照做，查到多个就把候选摊开并以 2 退出**。
 * 真实数据里 `sha256:5c095fff…` 确实对应三个 input_id，猜错了就是重写别人的笔记。
 */
function resolveSource(paths: VaultPaths, source: string): string | null {
  const wanted = source.startsWith('sha256:') ? source : `sha256:${source}`;
  const entries = readLedger(paths).entries;
  const inputIds = new Set<string>();
  for (const entry of entries) {
    if (entry.source_hash === wanted) inputIds.add(entry.input_id);
  }

  if (inputIds.size === 0) {
    throw new UsageError(
      `台账里没有哪个输入用这个指纹：${wanted}\n` +
        '  指纹是标准化之后原文的 sha256，可以在台账的 source_hash 字段里看到。\n' +
        '  不知道用哪个的话，直接跑 learnmate reprocess 看候选清单。',
    );
  }
  if (inputIds.size > 1) {
    process.stdout.write(
      `这个指纹对应 ${String(inputIds.size)} 次输入，没法判断你要哪一个：\n` +
        [...inputIds].sort((a, b) => a.localeCompare(b)).map((id) => `  · ${id}`).join('\n') +
        '\n  请改用 --input <input_id> 明确指定（同一个文件被整理过多次时，指纹是一样的）。\n',
    );
    return null;
  }
  const only = [...inputIds][0];
  if (only === undefined) throw new UsageError(`台账里没有哪个输入用这个指纹：${wanted}`);
  return only;
}

/* ------------------------------------------------------------------ *
 * 候选清单
 * ------------------------------------------------------------------ */

/** 打印「能重处理的都有哪些」，零写入。 */
function printCandidates(paths: VaultPaths): void {
  const candidates = collectCandidates(paths);
  const out = process.stdout;
  if (candidates.length === 0) {
    out.write('知识库里还没有可以重处理的输入（既没有草稿，也没有台账记录）。\n');
    return;
  }
  out.write('可以重处理的输入：\n');
  for (const candidate of candidates) {
    out.write(`  ${describeCandidate(candidate)}\n`);
  }
  out.write('\n指定一个再跑：\n');
  out.write('  learnmate reprocess --input <input_id>   重渲染这次输入的全部笔记（不调模型）\n');
  out.write('  learnmate reprocess --note <笔记 id>     只重渲染这一篇（不调模型）\n');
  out.write('  learnmate reprocess --source <指纹>      按指纹反查（查到多个会报候选）\n');
  out.write('  加 --dry-run 只看看会改哪些、一个字节都不写\n');
}

/** 把盘上的几处信息汇总成候选清单（纯读取，不写任何东西）。 */
function collectCandidates(paths: VaultPaths): ReprocessCandidate[] {
  const drafts = new Map<string, number | null>();
  for (const file of listDraftFiles(paths)) {
    const inputId = stripExtension(basename(file));
    drafts.set(inputId, countDraftNotes(paths, inputId));
  }
  const resolutionInputIds = listResolutionFiles(paths).map((file) =>
    stripExtension(basename(file)),
  );

  const ledgerSourceHashes = new Map<string, string>();
  const ledgerRowCounts = new Map<string, number>();
  const entries = readLedger(paths).entries;
  for (const entry of entries) {
    ledgerRowCounts.set(entry.input_id, (ledgerRowCounts.get(entry.input_id) ?? 0) + 1);
    if (!ledgerSourceHashes.has(entry.input_id)) {
      ledgerSourceHashes.set(entry.input_id, entry.source_hash);
    }
  }

  const noteInputIds = new Map<string, number>();
  for (const summary of readNoteSummaries(paths)) {
    const inputId = summary.frontmatter?.input_id;
    if (inputId === undefined || inputId === '') continue;
    noteInputIds.set(inputId, (noteInputIds.get(inputId) ?? 0) + 1);
  }

  return listCandidates({
    drafts,
    ledgerInputIds: [...ledgerRowCounts.keys()],
    ledgerSourceHashes,
    ledgerRowCounts,
    noteInputIds,
    resolutionInputIds,
  });
}

/**
 * 草稿里有几条笔记。
 *
 * 读不出来就返回 `null` 而不是抛错：候选清单是**只读的概览**，为了报一行「草稿读不出来」
 * 而让整条命令失败，对用户没有任何好处（真正要用这份草稿时，`--input` 那条路会自己报错）。
 */
function countDraftNotes(paths: VaultPaths, inputId: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readDraft(paths, inputId));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const notes = (parsed as { notes?: unknown }).notes;
    return Array.isArray(notes) ? notes.length : null;
  } catch {
    return null;
  }
}

function describeCandidate(candidate: ReprocessCandidate): string {
  const parts: string[] = [candidate.inputId];
  if (!candidate.hasDraft) parts.push('没有草稿');
  else if (candidate.draftNotes === null) parts.push('草稿读不出来');
  else parts.push(`草稿 ${String(candidate.draftNotes)} 条`);
  parts.push(`盘上 ${String(candidate.noteCount)} 篇`);
  parts.push(candidate.ledgerRows > 0 ? `台账 ${String(candidate.ledgerRows)} 行` : '台账无记录');
  if (candidate.sourceHash !== null) parts.push(candidate.sourceHash);
  if (candidate.hasResolutions) parts.push('有裁定文件');
  return parts.join('  ');
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]*$/u, '');
}
