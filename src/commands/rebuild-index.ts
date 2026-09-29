/**
 * `learnmate rebuild-index` —— 从 `notes/` 重建台账。
 *
 * 存在的理由只有一条，但它很硬：**台账是派生数据**。只要笔记文件还在，删掉
 * `ledger.jsonl` 就不该造成任何损失。没有这条命令，`ledger.jsonl` 就从「派生数据」
 * 悄悄变成了「唯一真相」——一个会被误删、会被同步冲突搞坏、还进不了 Git 的单点。
 *
 * 它也是查重坏掉之后的唯一出路：台账里的 `source_hash` 记错了，你就再也录不进那份笔记，
 * 而且没有任何提示告诉你为什么。
 *
 * 默认会写文件。`--dry-run` 只报告不写。
 */

import { loadConfig } from '../config.js';
import type { AppConfig } from '../config.js';
import { EXIT, UsageError } from '../core/errors.js';
import type { ExitCode } from '../core/errors.js';
import { rebuildLedger } from '../io/ledger.js';
import { vaultPaths } from '../io/vault.js';

export interface RebuildIndexOptions {
  /** 只扫描和报告，不写任何文件。 */
  dryRun?: boolean;
}

export function runRebuildIndex(options: RebuildIndexOptions = {}): ExitCode {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(`LearnMate 台账重建\n\n✗ 检查没通过：\n\n${error.message}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }

  const paths = vaultPaths(config.vaultPath);
  const report = rebuildLedger(paths, { write: options.dryRun !== true });

  const lines: string[] = ['LearnMate 台账重建', ''];
  lines.push(`  vault    ${config.vaultPath}`);
  lines.push(`  notes/   扫到 ${report.scanned} 个笔记文件`);
  lines.push('');

  if (report.scanned === 0) {
    lines.push('  notes/ 里一个笔记文件都没有，没什么可重建的。');
    lines.push('');
    lines.push('  如果这不对：先确认配置文件里的 vaultPath 指向的是你真正在用的知识库。');
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.OK;
  }

  lines.push(`  ✓ 沿用    ${report.reused} 条  （台账里已有，带着用量和耗时，原样保留）`);
  lines.push(`  + 新造    ${report.created} 条  （笔记文件在，台账里没有）`);
  lines.push(`  - 剔除    ${report.dropped} 条  （台账里有，但笔记文件已经不在了）`);
  lines.push(`  · 历史    ${report.keptHistory} 条  （失败、取消、跳过：本来就没有笔记文件）`);
  lines.push('');

  if (report.damagedLines > 0) {
    lines.push(`  ⚠ 原台账里有 ${report.damagedLines} 行读不懂，没能带过来。`);
    lines.push('    多半是断电劈出的半行。它们本来就已经不是有效记录了，');
    lines.push('    但重建会把这些行**从文件里抹掉**——想留个底的话，先备份 ledger.jsonl。');
    lines.push('');
  }

  if (report.unreadable.length > 0) {
    lines.push(`  ⚠ ${report.unreadable.length} 个文件没能读懂，**没有**进台账：`);
    for (const item of report.unreadable) {
      lines.push(`      ${item.fileName}`);
      lines.push(`        ${item.reason}`);
    }
    lines.push('');
    lines.push('  这些文件还在磁盘上，一个字都没动。手工看一眼 frontmatter 是不是被改坏了。');
    lines.push('');
  }

  if (report.writtenTo === null) {
    lines.push(`结果：--dry-run，没有写任何文件。本该写成 ${report.total} 条记录。`);
  } else {
    lines.push(`结果：.learnmate\\ledger.jsonl 已重建，共 ${report.total} 条记录。`);
  }
  if (report.unreadable.length > 0) {
    lines.push(`      注意：有 ${report.unreadable.length} 个笔记文件被跳过，台账是**不完整**的。`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT.OK;
}
