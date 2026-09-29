/**
 * `learnmate doctor` —— 检查配置、密钥与目录是否就绪，顺便给知识库做一次体检。
 *
 * 为什么需要这条命令：配置是看不见的东西。没有它，你只能在真正调用模型的那一刻
 * 才发现 Key 没读到、路径写错了、模板文件不在。doctor 把这件事变成一条随时能跑、
 * 只看不写的检查，报错的时候直接告诉你该改哪一行。
 *
 * 承诺：**不调用模型、不创建任何目录、不写任何文件、不删任何文件。**
 *
 * T11 加的这一节（知识库体检）也只读：「你看到的那份文件」和「台账里记的那件事」
 * 是不是同一件事，只有把两边都数一遍才知道。任何一项对不上都只是**报告**，
 * 不让命令失败——doctor 是拿来找问题的，不是拿来拦住你的。
 */

import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../config.js';
import type { LedgerInputRow, LedgerNoteRow } from '../core/contracts.js';
import { EXIT, UsageError } from '../core/errors.js';
import type { ExitCode } from '../core/errors.js';
import { readLedger } from '../io/ledger.js';
import {
  listDraftFiles,
  listNoteFiles,
  listQuarantineFiles,
  listRawFiles,
  readText,
  vaultPaths,
  vaultRelativePath,
  type VaultPaths,
} from '../io/vault.js';

export function runDoctor(): ExitCode {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(`LearnMate 配置检查\n\n✗ 检查没通过：\n\n${error.message}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }

  const problems: string[] = [];
  const rows: Array<[label: string, value: string]> = [];

  rows.push(['configFile', config.configPath]);

  const vaultExists = existsSync(config.vaultPath);
  rows.push([
    'vaultPath',
    vaultExists ? config.vaultPath : `${config.vaultPath}   （还不存在）`,
  ]);

  rows.push(['model', config.model]);
  rows.push(['baseUrl', config.baseUrl]);
  rows.push(['promptVersion', config.promptVersion]);

  const promptExists = existsSync(config.promptPath);
  if (!promptExists) {
    problems.push(`提示词文件不存在：${config.promptPath}`);
  }
  rows.push([
    'promptFile',
    promptExists ? config.promptPath : `${config.promptPath}   （还不存在）`,
  ]);

  rows.push(['maxInputChars', String(config.maxInputChars)]);
  rows.push(['requestTimeoutMs', String(config.requestTimeoutMs)]);
  rows.push(['apiKeyEnv', config.apiKeyEnv]);

  if (config.apiKey === undefined) {
    problems.push(
      `环境变量 ${config.apiKeyEnv} 没设置。cmd.exe 里：set ${config.apiKeyEnv}=你的密钥` +
        `（PowerShell 里：$env:${config.apiKeyEnv} = "你的密钥"）`,
    );
  }
  rows.push(['apiKey', describeApiKey(config.apiKey)]);

  rows.push(['node', process.version]);

  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');

  const verdict =
    problems.length === 0
      ? '\n结果：全部就绪。'
      : `\n结果：还差 ${problems.length} 项 ——\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`;

  process.stdout.write(`LearnMate 配置检查\n\n${body}\n${verdict}\n`);
  process.stdout.write(`\n${vaultReport(config.vaultPath)}\n`);

  if (problems.length > 0) {
    return EXIT.USAGE;
  }

  return EXIT.OK;
}

/** 同类问题超过这个数就只列前几个，剩下的用一句话交代——医生负责诊断，不负责刷屏。 */
const PREVIEW_LIMIT = 5;

/**
 * 知识库体检：把「磁盘上有什么」和「台账里记了什么」都数一遍，对不上就报出来。
 *
 * 只读、只报告：**绝不删任何东西，也绝不让 doctor 失败。** 知识库坏掉的时候，
 * 你需要的是一条能跑通、能告诉你「先看哪里」的命令，而不是第二条报错。
 *
 * 判据是契约 §9.3 的那条不变量：`raw/<input_id>.txt` 在，台账里就必须有它的行。
 * 反过来说，孤儿原文就是「走到过原文落盘、却没有任何结局」的输入——T11 之前
 * 这种输入在台账里完全不存在，`rebuild-index` 又是从 notes 重建的，所以它们
 * 永远查不出来。这个数字就是 T11 要消灭的东西。
 *
 * 只收一个知识库路径而不是整个配置，是为了能直接拿一个临时目录测它
 * （`tests/doctor.test.ts`）——体检的判据全在磁盘上，和配置没关系。
 */
export function vaultReport(vaultPath: string): string {
  const paths = vaultPaths(vaultPath);
  const rawFiles = listRawFiles(paths);
  const draftFiles = listDraftFiles(paths);
  const noteFiles = listNoteFiles(paths);
  const quarantineFiles = listQuarantineFiles(paths);
  const { entries, skippedLines } = readLedger(paths);

  const lines: string[] = ['知识库体检', ''];

  const neverIngested =
    !existsSync(vaultPath) ||
    rawFiles.length + draftFiles.length + noteFiles.length + entries.length === 0;
  if (neverIngested) {
    lines.push('  空知识库（还没有录入过）。');
    return lines.join('\n');
  }

  const okRows = entries.filter((entry): entry is LedgerNoteRow => entry.outcome === 'ok');
  const inputRows = entries.filter((entry): entry is LedgerInputRow => entry.outcome !== 'ok');

  // 台账里出现过的 input_id 就是「有结局的输入」。孤儿 = 文件在，这个集合里没有它。
  const knownIds = new Set(entries.map((entry) => entry.input_id));
  const orphanRaw = rawFiles.filter((file) => !knownIds.has(inputIdOf(file)));
  const orphanDraft = draftFiles.filter((file) => !knownIds.has(inputIdOf(file)));

  const documentedNotes = new Set(okRows.map((entry) => entry.note_path));
  const latestScene = quarantineFiles.at(-1);

  lines.push(`  原文          ${String(rawFiles.length)} 份`);
  lines.push(`  草稿          ${String(draftFiles.length)} 份`);
  lines.push(`  笔记          ${String(noteFiles.length)} 篇`);
  lines.push(
    `  台账          ${String(entries.length)} 行` +
      `（笔记 ${String(okRows.length)} 行，历史 ${String(inputRows.length)} 行）`,
  );
  lines.push('');

  lines.push(`  孤儿原文      ${describeCount(orphanRaw.length, '个')}`);
  if (orphanRaw.length > 0) {
    lines.push(preview(paths, orphanRaw));
    lines.push('      别手工删：raw/ 里的原文是唯一的一份，删了就重新整理不了了。');
  }

  lines.push(`  孤儿草稿      ${describeCount(orphanDraft.length, '个')}`);
  if (orphanDraft.length > 0) {
    lines.push(preview(paths, orphanDraft));
    lines.push('      draft/ 是模型的原始产出，重跑一次输入就会重新生成；不确定就先留着。');
  }

  // 笔记文件数应该等于台账里不同的 note_path 数。对不上不是「坏了」，是「该重建了」。
  const notesMatch = noteFiles.length === documentedNotes.size;
  lines.push(
    notesMatch
      ? `  notes 与台账  ✓ 对得上（${String(noteFiles.length)} 篇）`
      : `  notes 与台账  ✗ 对不上：notes/ 里 ${String(noteFiles.length)} 篇，台账里 ${String(documentedNotes.size)} 条`,
  );
  if (!notesMatch) {
    lines.push('      跑一次 node dist/main.js rebuild-index --dry-run 看看差在哪（台账是派生数据，能重建）。');
  }

  lines.push(
    skippedLines === 0
      ? '  台账坏行      ✓ 没有'
      : `  台账坏行      ✗ ${String(skippedLines)} 行读不出来（下一次 rebuild-index 会把它抹掉）`,
  );

  lines.push(
    quarantineFiles.length === 0
      ? '  校验现场      ✓ 没有'
      : `  校验现场      ✗ ${String(quarantineFiles.length)} 个，最近的一个：`,
  );
  if (latestScene !== undefined) {
    lines.push(`      ${vaultRelativePath(paths, latestScene)}`);
    const message = sceneMessage(latestScene);
    if (message !== null) {
      lines.push(`      它说：${message}`);
    }
    lines.push('      里面存着模型每一次的原始产出，为什么不合契约一看就知道。');
  }

  if (inputRows.length === 0) {
    lines.push('  历史行        ✓ 没有（每一次输入都有笔记）');
  } else {
    const counts = new Map<string, number>();
    for (const row of inputRows) {
      counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
    }
    const summary = [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([outcome, count]) => `${outcome} ${String(count)}`)
      .join('，');
    lines.push(`  历史行        ${String(inputRows.length)} 行：${summary}`);
  }

  return lines.join('\n');
}

/** `✓ 没有` 或者 `✗ 3 个`。 */
function describeCount(count: number, unit: string): string {
  return count === 0 ? '✓ 没有' : `✗ ${String(count)} ${unit}`;
}

/** 不刷屏：同类超过 5 个只列前 5 个，剩下的用一句话交代。 */
function preview(paths: VaultPaths, files: readonly string[]): string {
  const shown = files
    .slice(0, PREVIEW_LIMIT)
    .map((file) => `      ${vaultRelativePath(paths, file)}`);
  if (files.length > PREVIEW_LIMIT) {
    shown.push(`      …… 还有 ${String(files.length - PREVIEW_LIMIT)} 个`);
  }
  return shown.join('\n');
}

/** 从 `…/raw/01ABC.txt` 取出 `01ABC`。 */
function inputIdOf(filePath: string): string {
  return basename(filePath, extname(filePath));
}

/** 现场 JSON 里的 `message`。读不出来就算了——体检不该被一个坏文件拖垮。 */
function sceneMessage(filePath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readText(filePath));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = (parsed as Record<string, unknown>)['message'];
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** 绝不打印密钥本身，只给足够确认「读到的是哪一个」的信息。 */
function describeApiKey(apiKey: string | undefined): string {
  if (apiKey === undefined) return '✗ 未设置';
  if (apiKey.length <= 4) return `✓ 已设置（${apiKey.length} 字符）`;
  return `✓ 已设置（共 ${apiKey.length} 字符，结尾 …${apiKey.slice(-4)}）`;
}
