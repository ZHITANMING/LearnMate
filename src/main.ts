#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { runAddCommand } from './commands/add.js';
import { runDoctor } from './commands/doctor.js';
import { runListCommand } from './commands/list.js';
import { runRebuildIndex } from './commands/rebuild-index.js';
import { runReprocessCommand } from './commands/reprocess.js';
import { runShowCommand } from './commands/show.js';
import { runTagsCommand } from './commands/tags.js';
import { EXIT, LearnMateError } from './core/errors.js';

/**
 * 版本号只有 package.json 一个出处，不在这里再抄一遍。
 * 从 src/main.ts 和 dist/main.js 往上一级都是仓库根目录，所以同一个写法两边都能用。
 */
function readVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  return pkg.version;
}

const program = new Command();

program
  .name('learnmate')
  .description('把学习笔记整理成结构化 Markdown，存进你自己的知识库')
  .version(readVersion())
  // commander 默认遇到用法错误会自己 exit(1)，但契约（docs/03-contracts.md 第 7 节）
  // 里用法错误是 2。打开 exitOverride 后它改为抛异常，交给 handleFatal 统一翻译。
  // （子命令会继承这个设置，所以必须在 .command() 之前调用。）
  .exitOverride()
  .showHelpAfterError('（运行 learnmate --help 查看用法）');

program
  .command('add')
  .description('把一段文字或一个文件交给 AI 整理成笔记（会调用模型、会写文件）')
  .argument('[source]', '要整理的文件（.txt / .md / .docx）；用 - 表示从标准输入读')
  .option('--yes', '不逐条确认，全部接受（适合批量录入）')
  .option('--dry-run', '只预览，一个文件都不写（会照常调用模型）')
  .option('--force', '即使这份输入已经处理过，也重新跑一遍')
  .action(
    async (
      source: string | undefined,
      options: { yes?: boolean; dryRun?: boolean; force?: boolean },
    ) => {
      process.exitCode = await runAddCommand({
        source,
        yes: options.yes === true,
        dryRun: options.dryRun === true,
        force: options.force === true,
      });
    },
  );

program
  .command('doctor')
  .description('检查配置、API Key 与目录是否就绪（不调用模型，不写任何文件）')
  .action(() => {
    process.exitCode = runDoctor();
  });

program
  .command('list')
  .description('列出知识库里的笔记（只读，不调用模型，不需要 API Key）')
  .option('--tag <标签>', '只看带这个标签的笔记（大小写不敏感）')
  .option('--status <状态>', '只看这个状态：inbox | processed | reviewed')
  .action((options: { tag?: string; status?: string }) => {
    process.exitCode = runListCommand({ tag: options.tag, status: options.status });
  });

program
  .command('show')
  .description('打出一篇笔记（只读，不调用模型，不需要 API Key）')
  .argument('<关键词>', '完整 26 位 id，或标题/文件名里的一段文字')
  .option('--raw', '连 frontmatter 一起打出来（默认只打正文）')
  .action((query: string, options: { raw?: boolean }) => {
    process.exitCode = runShowCommand(query, { raw: options.raw === true });
  });

program
  .command('tags')
  .description('列出知识库里用过的标签，一行一个（与 add 注入给模型的词表同一份）')
  .option('--counts', '每个标签后面跟上它被几篇笔记用过')
  .action((options: { counts?: boolean }) => {
    process.exitCode = runTagsCommand({ counts: options.counts === true });
  });

program
  .command('reprocess')
  .description('用留下来的草稿重新渲染笔记（默认不调用模型、不需要 API Key）')
  .option('--input <input_id>', '重渲染这一次输入拆出来的全部笔记')
  .option('--note <note_id>', '只重渲染这一篇笔记')
  .option('--source <source_hash>', '按原文指纹反查这次输入（查到多个会报候选）')
  .option('--reanalyze', '重新分析（会调用模型，需要 API Key）')
  .option('--dry-run', '只报告会怎么改，一个字节都不写')
  .option('--yes', '不逐条确认，全部接受')
  .action(
    async (options: {
      input?: string;
      note?: string;
      source?: string;
      reanalyze?: boolean;
      dryRun?: boolean;
      yes?: boolean;
    }) => {
      process.exitCode = await runReprocessCommand({
        input: options.input,
        note: options.note,
        source: options.source,
        reanalyze: options.reanalyze === true,
        dryRun: options.dryRun === true,
        yes: options.yes === true,
      });
    },
  );

program
  .command('rebuild-index')
  .description('从 notes/ 重建台账（台账是派生数据，删了也能长回来）')
  .option('--dry-run', '只报告会怎么重建，不写任何文件')
  .action((options: { dryRun?: boolean }) => {
    process.exitCode = runRebuildIndex({ dryRun: options.dryRun === true });
  });

async function main(): Promise<void> {
  // 不带参数运行应该看到帮助，而不是静默退出 0 —— 静默退出会让人以为命令跑成功了。
  if (process.argv.length <= 2) {
    program.help();
    return;
  }
  await program.parseAsync(process.argv);
}

/**
 * 把所有逃出来的异常翻译成退出码。
 * 这里是「异常 → 退出码」这条契约（0/1/2/3/4）唯一的落地点。
 */
function handleFatal(error: unknown): void {
  if (error instanceof CommanderError) {
    // --help / --version 是正常的「退出」，不是错误。
    const normalExit =
      error.code === 'commander.helpDisplayed' ||
      error.code === 'commander.help' ||
      error.code === 'commander.version';
    process.exitCode = normalExit ? EXIT.OK : EXIT.USAGE;
    return;
  }

  if (error instanceof LearnMateError) {
    process.stderr.write(`\n错误：${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }

  // 不认识的异常一律按「未预期」处理并打印堆栈，绝不静默吞掉。
  process.stderr.write('\n发生了未预期的错误（这是 bug，不是你的操作问题）：\n');
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = EXIT.UNEXPECTED;
}

main().catch(handleFatal);
