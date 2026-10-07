/**
 * `learnmate add` 的命令层。
 *
 * 它只做三件事：**检查配置与密钥 → 拿到输入 → 把零件交给 `pipeline`**。
 * 流程本身一行都不在这里（那是 pipeline 的事），判断「这条笔记要不要写」也不在这里
 * （那是用户的事，通过下面的 `TerminalPrompter`）。
 *
 * 顺序上有一个刻意的安排：**所有前置检查都在读输入之前做完**（配置、密钥、提示词文件）。
 * 退出码 2 承诺「不产生任何写入」，缺 Key、缺提示词文件都是典型的用法错误；先检查，
 * 用户就不必先打完一段字、再被告知「你还没设密钥」。
 *
 * 这些检查**不用异常**往回传，而是各自返回 `null` 让调用方返回退出码 2：异常通道
 * 留给「意外」，而这里的三种情况都是意料之中的，消息也由这里排好版
 * （跟着 `rebuild-index` 的样式，免得同一个项目里有两种「检查没通过」的排版）。
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { loadConfig, requireApiKey } from '../config.js';
import { EXIT, UsageError, type ExitCode } from '../core/errors.js';
import { createChatFunction } from '../io/llm.js';
import { readPromptTemplate } from '../io/prompt.js';
import { docxToText, isDocxFile } from '../io/readers/docx.js';
import { vaultPaths } from '../io/vault.js';
import {
  runAdd,
  type AddPrompter,
  type NoteDecision,
  type NotePreview,
  type UncertainPreview,
  type UncertainResolution,
} from '../pipeline.js';

export interface AddCommandOptions {
  /** 输入文件；`-` 表示从标准输入读。两者都不给时见 `readInput` 里的 TTY 判断。 */
  source?: string;
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** 命令入口。返回退出码；用法/校验/网络错误按既有异常通道往上抛。 */
export async function runAddCommand(options: AddCommandOptions): Promise<ExitCode> {
  const config = requireSetup(() => loadConfig());
  if (config === null) return EXIT.USAGE;

  const apiKey = requireSetup(() => requireApiKey(config));
  if (apiKey === null) return EXIT.USAGE;

  const template = requireSetup(() => readPromptTemplate(config.promptPath, config.promptVersion));
  if (template === null) return EXIT.USAGE;

  const { text, sourceRef } = readInput(options.source);
  const paths = vaultPaths(config.vaultPath);
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
    return await runAdd(text, {
      paths,
      template,
      model: config.model,
      promptVersion: config.promptVersion,
      chat,
      maxInputChars: config.maxInputChars,
      sourceRef,
      yes: options.yes === true,
      dryRun: options.dryRun === true,
      force: options.force === true,
      prompter,
    });
  } finally {
    // 不论成功、失败还是抛异常，都要把标准输入的占用还回去——
    // 否则进程可能停在一个没人再读的 readline 上不退出。
    prompter.close();
  }
}

/* ------------------------------------------------------------------ *
 * 前置检查
 * ------------------------------------------------------------------ */

/**
 * 跑一步「此时此刻还什么都没写」的检查。
 *
 * 只有 `UsageError` 会被翻译成「打印 + 退出码 2」——那是这一步唯一说得通的失败
 * （参数/配置问题）。别的异常一律继续往上抛，绝不在这里静默吞掉。
 */
function requireSetup<T>(step: () => T): T | null {
  try {
    return step();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(`LearnMate 录入\n\n✗ 检查没通过：${error.message}\n`);
      return null;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 取输入
 * ------------------------------------------------------------------ */

interface Input {
  text: string;
  /** 只存文件名；从标准输入读时为 undefined。 */
  sourceRef: string | undefined;
}

/**
 * 把「用户给的那个东西」变成一段待整理的文本。
 *
 * 只有两种输入形态：**标准输入**和**一个文件**。文件里目前认两种：UTF-8 纯文本
 * （直接读）和 `.docx`（先抽成文字，见 `src/io/readers/docx.ts`）。抽取走的是
 * 契约 5.6 那条路，抽完就和纯文本输入没有任何区别。
 *
 * 导出它只是为了让测试能从一个真的文件读出东西来（命令层其余部分都要调用模型）。
 */
export function readInput(source: string | undefined): Input {
  if (source === undefined) {
    // 没参数、又坐在终端前，说明用户还不知道这个命令要吃什么。
    // 直接等标准输入看起来就像「卡住了」——那是最让人困惑的一种失败。
    if (process.stdin.isTTY === true) {
      throw new UsageError(
        '还没有说要整理什么。\n' +
          '  用法：learnmate add 笔记.txt\n' +
          '  或者：type 笔记.txt | learnmate add -\n' +
          '  Word 文档也行：learnmate add 示例输入.docx\n' +
          '  （换行符、缩进都不用管，工具会先做一遍规范化。）',
      );
    }
    return { text: readStdin(), sourceRef: undefined };
  }

  if (source === '-') return { text: readStdin(), sourceRef: undefined };

  const filePath = resolve(source);
  const fileName = basename(filePath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new UsageError(`读不到这个文件：${filePath}\n  ${describeCause(error)}`);
  }

  // `.docx` 是压缩包，按文本读只会得到一屏乱码。先抽出文字，再交给后面那条同一条路。
  if (isDocxFile(fileName)) return { text: docxToText(bytes), sourceRef: fileName };
  return { text: bytes.toString('utf8'), sourceRef: fileName };
}

function readStdin(): string {
  try {
    // fd 0 = 标准输入。同步读是为了让「读输入」保持同步——它之后的一切
    // （规范化、查重）都不需要异步。
    return readFileSync(0, 'utf8');
  } catch (error) {
    throw new UsageError(`从标准输入读不到内容。\n  ${describeCause(error)}`);
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * 提问
 * ------------------------------------------------------------------ */

/** 预览用的分隔线。宽度只是好看，不参与任何逻辑。 */
const RULE = '─'.repeat(56);

/** 对话用的两条流。不传就是真实终端的标准输入 / 标准输出。 */
export interface PrompterStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * 真正和用户对话的实现：从标准输入读一行，往标准输出打印。
 *
 * readline 的接口是**懒创建**的：`--yes` 全程不用提问，也就不该去碰标准输入
 * （碰了会让「管道里还喂着别的东西」这种场景变得莫名其妙）。`close()` 则必须调，
 * 否则进程可能停在打开了的标准输入上不退出。
 *
 * 两条流可以从外面塞进来（T11）：把「和用户对话」这件事从「真实终端」里拆出来，
 * 才可能在测试里喂它几行、看它回什么——这个类的三个坑（早到的行会丢、输入结束时
 * 悬着的 `await` 永远不返回、关掉之后再问会抛异常）全都只在**非终端输入**时才出现，
 * 而它们每一个都会让整批笔记静默地一条都不写。不传参数时行为与从前逐字相同。
 */
export class TerminalPrompter implements AddPrompter {
  #readline: Interface | undefined;
  #closed = false;
  /** 已经收到、但还没人问起的那些行（见 `#ask` 的说明）。 */
  #pending: string[] = [];
  /** 正在等下一行的人。同一时刻只会有一个：提问是一条一条来的。 */
  #waiting: ((line: string | null) => void) | undefined;
  /** 已经打印过「存疑 N 处」表头的那条笔记，免得每条存疑都重复一遍表头。 */
  #headerFor = -1;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;

  constructor(streams: PrompterStreams = {}) {
    this.#input = streams.input ?? process.stdin;
    this.#output = streams.output ?? process.stdout;
  }

  async confirmNote(preview: NotePreview): Promise<NoteDecision> {
    this.#headerFor = -1;
    this.#write('');
    this.#write(
      `[${String(preview.index)}/${String(preview.total)}] ${preview.draft.title}` +
        (preview.draft.tags.length === 0 ? '' : `   tags: ${preview.draft.tags.join(' · ')}`),
    );
    this.#write(RULE);
    this.#write(preview.markdown.trimEnd());
    this.#write(RULE);

    for (;;) {
      const answer = normalize(
        await this.#ask('写入这条？ [y] 写入  [n] 跳过  [a] 全部接受  [q] 退出 '),
      );
      // 读到文件尾：不再有回答了。当作「退出」，什么都别写。
      if (answer === null) return 'quit';
      if (answer === 'y' || answer === 'yes' || answer === '是') return 'write';
      if (answer === 'n' || answer === 'no' || answer === '否') return 'skip';
      if (answer === 'a' || answer === 'all') return 'accept-all';
      if (answer === 'q' || answer === 'quit' || answer === 'exit') return 'quit';
      if (answer === '') continue; // 光敲回车不算回答，再问一次。
      this.#write('没看懂。回复 y（写入）、n（跳过）、a（全部接受）或者 q（退出）。');
    }
  }

  async resolveUncertain(preview: UncertainPreview): Promise<UncertainResolution> {
    if (this.#headerFor !== preview.noteIndex) {
      this.#headerFor = preview.noteIndex;
      this.#write('');
      this.#write(`存疑 ${String(preview.total)} 处：`);
    }
    this.#write(`  [${String(preview.index)}] ${preview.item.text}`);
    this.#write(`      我的疑问：${preview.item.reason}`);

    for (;;) {
      const answer = normalize(
        await this.#ask('      [k] 保留为「待确认」  [d] 删除  [e] 我来改写 '),
      );
      // 读到文件尾时按「保留」处理：保留是契约里的默认值，而且它不会让内容消失。
      if (answer === null || answer === '' || answer === 'k' || answer === 'keep') {
        return { action: 'keep' };
      }
      if (answer === 'd' || answer === 'drop' || answer === 'delete') return { action: 'drop' };
      if (answer === 'e' || answer === 'edit') {
        const text = await this.#ask('      请写一句更正（会作为「更正为：…」写进待确认）：');
        const trimmed = text?.trim() ?? '';
        if (trimmed === '') {
          this.#write('      没写内容，这一处仍然按「保留」处理。');
          return { action: 'keep' };
        }
        return { action: 'edit', text: trimmed };
      }
      this.#write('      没看懂。回复 k（保留）、d（删除）或者 e（改写）。');
    }
  }

  close(): void {
    this.#closed = true;
    this.#readline?.close();
    this.#readline = undefined;
  }

  #write(message: string): void {
    this.#output.write(`${message}\n`);
  }

  /** 只写提示语本身，不换行——等问题回答完，光标就该停在那一行上。 */
  #writePrompt(prompt: string): void {
    this.#output.write(prompt);
  }

  /**
   * 问一句，返回用户敲的那一行；`null` 表示已经没有输入可读了。
   *
   * 这里**故意不用** `readline.question()`，因为输入不是终端时有三个坑，而且都会让
   * 整批笔记静默地一条都不写：
   *   1. `question()` 只认「它提出问题之后」到达的行——输入被一次性喂进来（管道、
   *      重定向文件）时，先到的几行会在没有提问者的情况下被丢掉；
   *   2. 输入结束时悬着的那个 `question()` 永远不会返回，`await` 就一直挂着，
   *      事件循环空了，进程以退出码 0 静默退出——用户看到的是「什么都没发生」；
   *   3. 接口关掉之后再问，它会抛异常（那倒还算好的，至少能被看见）。
   * 自己挂一个**常驻**的 `line` 监听、把行先存进队列，这三个坑就都不存在了：
   * 早到的行不会丢，输入结束时等的人会立刻拿到 `null`（于是按「没有更多回答」处理）。
   *
   * 交互式终端（用户的日常用法）这两条路径本来就不会走到，但「管道喂答案」是
   * 脚本和演示会用的正经用法，不能让它把整理到一半的批次丢掉。
   */
  async #ask(prompt: string): Promise<string | null> {
    const buffered = this.#pending.shift();
    if (buffered !== undefined) {
      this.#writePrompt(prompt);
      return buffered;
    }
    if (this.#closed) return null;

    const readline = this.#interface();
    if (readline === null) return null;
    this.#writePrompt(prompt);
    return await new Promise<string | null>((resolve) => {
      this.#waiting = resolve;
    });
  }

  #interface(): Interface | null {
    if (this.#closed) return null;
    if (this.#readline === undefined) {
      const readline = createInterface({ input: this.#input, output: this.#output });
      // 常驻监听：从这一刻起，不管有没有人在问，行都先存下来。
      readline.on('line', (line: string) => {
        const waiting = this.#waiting;
        if (waiting === undefined) this.#pending.push(line);
        else {
          this.#waiting = undefined;
          waiting(line);
        }
      });
      readline.on('close', () => {
        // 输入没了（Ctrl+D / Ctrl+Z / 管道结束）。等的人立刻醒过来，
        // 而不是永远挂着——那会让进程静默退出。
        this.#closed = true;
        const waiting = this.#waiting;
        this.#waiting = undefined;
        waiting?.(null);
      });
      this.#readline = readline;
    }
    return this.#readline;
  }
}

function normalize(answer: string | null): string | null {
  return answer === null ? null : answer.trim().toLowerCase();
}
