/**
 * `learnmate list` —— 知识库里有什么。
 *
 * 数据源是 `notes/` 目录本身，**不读台账**。理由是台账的定位：
 * 它是派生数据，契约 §9 允许用户整份删掉再重建。
 * 「我库里有什么」这个问题的答案不该依赖一个可以被删掉的文件。
 *
 * 承诺：**只读、零写入**。不建目录（连 `vault/` 都不建）、不改文件、不调模型、
 * 不需要 API Key。空知识库是 0 退出码，不是错误——新用户第一次跑 `list`
 * 看到的就是它。
 *
 * 渲染是纯函数（`renderNoteList`），测试直接调它，不用抓 stdout——和 `doctor`
 * 的 `vaultReport` 是同一个先例。
 */

import { basename } from 'node:path';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../config.js';
import type { NoteStatus, NoteSummary } from '../core/contracts.js';
import { EXIT, UsageError } from '../core/errors.js';
import type { ExitCode } from '../core/errors.js';
import { readNoteSummaries } from '../io/notes.js';
import { vaultPaths } from '../io/vault.js';

/**
 * 允许出现在 `--status` 里的值。
 *
 * 写成 `Record<NoteStatus, true>` 而不是数组，是为了让「类型里加了新状态、
 * 这里忘了跟」变成编译错误，而不是一条永远查不出的静默不一致。
 */
const NOTE_STATUS_VALUES: Record<NoteStatus, true> = {
  inbox: true,
  processed: true,
  reviewed: true,
};

export interface ListOptions {
  /** 只看带这个标签的笔记。大小写不敏感（标签里可能有中文，所以不是 ASCII 折叠）。 */
  tag?: string;
  /** 只看这个状态的笔记。 */
  status?: NoteStatus;
}

export interface RunListCommandOptions {
  tag?: string;
  status?: string;
  /** 配置文件的基目录，默认 `process.cwd()`。测试时传临时目录进来。 */
  baseDir?: string;
}

/**
 * 校验 `--status`。
 *
 * 给错了就**报错退出码 2**，不要静默当成「0 条」——用户会以为库里真的没有，
 * 而不是自己打错了字。
 */
export function parseStatusOption(value: string | undefined): NoteStatus | undefined {
  if (value === undefined) return undefined;

  if (!Object.prototype.hasOwnProperty.call(NOTE_STATUS_VALUES, value)) {
    const allowed = Object.keys(NOTE_STATUS_VALUES).join(' | ');
    throw new UsageError(`--status 只接受 ${allowed}，收到的是：${value}`);
  }

  return value as NoteStatus;
}

/** `2026-09-29T13:06:20+08:00` → `2026-09-29 13:06`。只动前 16 个字符。 */
function formatCreated(created: string): string {
  return created.slice(0, 16).replace('T', ' ');
}

/**
 * 一行笔记：`<26 位 id>  <status>  <created>  <标题>  [标签/标签]`。
 *
 * 导出是给 `show` 用的：候选清单必须与 `list` **同一个格式**，否则用户得在两套
 * 长相不同的清单之间做心算。格式只有这一处定义。
 */
export function renderNoteLine(summary: NoteSummary): string {
  const frontmatter = summary.frontmatter;
  if (frontmatter === null) {
    return `（读不懂）  ${basename(summary.relativePath)}  ——  ${summary.problem ?? '原因不明'}`;
  }

  const tags = [...frontmatter.tags].sort().join('/');
  return [frontmatter.id, frontmatter.status, formatCreated(frontmatter.created), frontmatter.title, `[${tags}]`].join(
    '  ',
  );
}

/**
 * 排序：`created` 新的在前（ISO 8601 字符串直接比），其次 `id` 升序，
 * 读不懂的（没有 `created`）永远排最后、彼此按文件名升序。
 *
 * 同一份知识库跑两次，输出必须逐字节相同。
 *
 * 导出是给 `show` 用的：候选清单的顺序应当与 `list` 看到的顺序一致。
 */
export function compareSummaries(a: NoteSummary, b: NoteSummary): number {
  const aFront = a.frontmatter;
  const bFront = b.frontmatter;

  if (aFront !== null && bFront !== null) {
    if (aFront.created !== bFront.created) return aFront.created < bFront.created ? 1 : -1;
    if (aFront.id !== bFront.id) return aFront.id < bFront.id ? -1 : 1;
    return 0;
  }

  // 读得懂的排前面，读不懂的沉底。
  if (aFront !== null) return -1;
  if (bFront !== null) return 1;

  // 都读不懂：按文件名升序（relativePath 前缀恒为 `notes/`，与按文件名同序）。
  if (a.relativePath === b.relativePath) return 0;
  return a.relativePath < b.relativePath ? -1 : 1;
}

function matchesFilters(summary: NoteSummary, options: ListOptions): boolean {
  const hasFilter = options.tag !== undefined || options.status !== undefined;
  const frontmatter = summary.frontmatter;

  // 读不懂的笔记没有可用来匹配的字段：不带过滤时照常显示（坏文件不许被静默吞掉），
  // 带过滤时它不可能命中。
  if (frontmatter === null) return !hasFilter;

  if (options.tag !== undefined) {
    const wanted = options.tag.trim().toLowerCase();
    const hit = frontmatter.tags.some((tag) => tag.trim().toLowerCase() === wanted);
    if (!hit) return false;
  }

  if (options.status !== undefined && frontmatter.status !== options.status) return false;

  return true;
}

const EMPTY_VAULT_MESSAGE =
  '知识库还是空的（还没有录入过任何笔记）。\n' +
  '先跑 node dist/main.js doctor 看看配置，再用 add 录入第一份材料。\n';

/**
 * 把摘要渲染成最终要打出去的那段字。**纯函数**：不看时钟、不碰文件、
 * 同样的输入永远得到逐字节相同的输出。
 */
export function renderNoteList(summaries: NoteSummary[], options: ListOptions = {}): string {
  if (summaries.length === 0) return EMPTY_VAULT_MESSAGE;

  const filtered = summaries.filter((summary) => matchesFilters(summary, options));
  const hasFilter = options.tag !== undefined || options.status !== undefined;

  if (filtered.length === 0) {
    return `没有符合这个条件的笔记（库里有 ${summaries.length} 篇）。\n`;
  }

  const lines = [...filtered].sort(compareSummaries).map(renderNoteLine);

  if (hasFilter) {
    lines.push(`符合这个条件的共 ${filtered.length} 篇（库里 ${summaries.length} 篇）。`);
  } else {
    const unreadable = filtered.filter((summary) => summary.frontmatter === null).length;
    lines.push(
      unreadable === 0
        ? `共 ${filtered.length} 篇。`
        : `共 ${filtered.length} 篇；其中 ${unreadable} 篇读不懂（frontmatter 坏了，文件还在，用 \`type\` 直接看）。`,
    );
  }

  return `${lines.join('\n')}\n`;
}

export function runListCommand(options: RunListCommandOptions = {}): ExitCode {
  // 先校验用法，再读配置：选项打错了不该先看到一条「配置文件有问题」。
  const status = parseStatusOption(options.status);

  const config: AppConfig = loadConfig({ baseDir: options.baseDir });

  // 只算路径，不建目录：`list` 是只读命令，连 `vault/` 都不该由它创建。
  const paths = vaultPaths(config.vaultPath);
  const summaries = readNoteSummaries(paths);

  process.stdout.write(renderNoteList(summaries, { tag: options.tag, status }));

  return EXIT.OK;
}
