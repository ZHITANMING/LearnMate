/**
 * 配置与密钥。
 *
 * 契约见 docs/03-contracts.md 第 8 节。三条要点：
 *   1. 配置文件 `learnmate.config.json` **不提交**，模板 `learnmate.config.example.json` 提交。
 *   2. `model` 是唯一必填项，没有默认值。
 *   3. **铁律：API Key 只能来自环境变量，永不写入配置文件。** 配置文件里只允许出现变量名。
 *
 * 本文件允许碰 IO（读文件、读环境变量），属于架构里的 config 层。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, describeError } from './core/errors.js';

/** 真正的配置文件。已列入 .gitignore。 */
export const CONFIG_FILE_NAME = 'learnmate.config.json';

/** 仓库里提交的模板。 */
export const CONFIG_EXAMPLE_FILE_NAME = 'learnmate.config.example.json';

/** 提示词文件所在目录，相对于 baseDir。 */
const PROMPTS_DIR = 'prompts';

/** 契约第 8 节定义的默认值。 */
const DEFAULTS = {
  vaultPath: './vault',
  baseUrl: 'https://api.deepseek.com/v1',
  promptVersion: 'analyze.v2',
  maxInputChars: 20_000,
  requestTimeoutMs: 60_000,
  apiKeyEnv: 'LEARNMATE_API_KEY',
} as const;

/** 配置文件的全部合法字段。多一个少一个都会被指出来。 */
const KNOWN_KEYS = [
  'vaultPath',
  'model',
  'baseUrl',
  'promptVersion',
  'maxInputChars',
  'requestTimeoutMs',
  'apiKeyEnv',
] as const;

export interface AppConfig {
  /** 我们去找的就是这个文件（绝对路径）。找不到它时 `loadConfig` 会抛出 UsageError。 */
  readonly configPath: string;
  /** 相对路径的解析基准 = 运行命令时的工作目录。 */
  readonly baseDir: string;
  /** 配置里写的原文（或默认值）。只用于展示，不要拿它当路径用。 */
  readonly vaultPathRaw: string;
  /** 知识库目录，已解析为绝对路径。此文件**不负责创建它**（那是 io/vault.ts 的事）。 */
  readonly vaultPath: string;
  /** 模型标识，会写进每条笔记的 frontmatter。必填。 */
  readonly model: string;
  /**
   * 模型服务的基地址，不含尾斜杠，例如 `https://api.deepseek.com/v1`。
   * 请求实际打到 `<baseUrl>/chat/completions`。默认 DeepSeek（OpenAI 兼容接口）。
   */
  readonly baseUrl: string;
  /** 例如 `analyze.v1`。 */
  readonly promptVersion: string;
  /** `prompts/<promptVersion>.md` 的绝对路径。 */
  readonly promptPath: string;
  readonly maxInputChars: number;
  readonly requestTimeoutMs: number;
  /** 存放密钥的**环境变量名**，不是密钥本身。 */
  readonly apiKeyEnv: string;
  /** 密钥本身。未设置时为 undefined。**永远不要打印它、写进文件或日志。** */
  readonly apiKey: string | undefined;
}

export interface LoadConfigOptions {
  /** 默认 `process.cwd()`。测试时传一个临时目录进去。 */
  baseDir?: string;
  /** 默认 `process.env`。测试时传一个假的环境进去。 */
  env?: NodeJS.ProcessEnv;
}

interface ConfigProblem {
  readonly key: string;
  readonly message: string;
}

/**
 * 读出配置。配置本身有问题（类型错、未知字段、缺必填项）时抛出 `UsageError`，
 * 并且**一次把所有问题列全**——不要让人改一个跑一次。
 *
 * 文件不存在不算错误：全部走默认值，唯一的必填项 `model` 会在下面被指出来。
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const baseDir = options.baseDir ?? process.cwd();
  const env = options.env ?? process.env;

  const configPath = join(baseDir, CONFIG_FILE_NAME);
  const source = readConfigFile(configPath);
  const problems: ConfigProblem[] = [];

  // —— 未知字段：打字打错一个字母就静默失效，是最难查的一类问题，所以直接报错 ——
  for (const key of Object.keys(source)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      const hint = suggestKey(key, KNOWN_KEYS);
      problems.push({
        key,
        message: `未知字段${hint === undefined ? '' : `，你是不是想写 ${hint}？`}`,
      });
    }
  }

  const vaultPathRaw = readNonEmptyString(source, 'vaultPath', problems) ?? DEFAULTS.vaultPath;
  const model = readNonEmptyString(source, 'model', problems);
  const baseUrl = readUrl(source, 'baseUrl', problems) ?? DEFAULTS.baseUrl;
  const promptVersion =
    readNonEmptyString(source, 'promptVersion', problems) ?? DEFAULTS.promptVersion;
  const maxInputChars =
    readPositiveInt(source, 'maxInputChars', problems) ?? DEFAULTS.maxInputChars;
  const requestTimeoutMs =
    readPositiveInt(source, 'requestTimeoutMs', problems) ?? DEFAULTS.requestTimeoutMs;
  const apiKeyEnv = readNonEmptyString(source, 'apiKeyEnv', problems) ?? DEFAULTS.apiKeyEnv;

  // model 是唯一必填项。它「写了但类型不对 / 是空的」已经在上面的读函数里报过了，
  // 这里只补「压根没写」这一种。
  if (source['model'] === undefined) {
    problems.push({
      key: 'model',
      message: '必填。填你用的模型标识（会写进每条笔记的 frontmatter），例如 deepseek-chat',
    });
  }

  // promptVersion 会被拼成文件名，必须挡住 `../` 这类东西。
  if (promptVersion !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(promptVersion)) {
    problems.push({
      key: 'promptVersion',
      message: '只能由字母、数字、点、下划线、连字符组成，且必须以字母或数字开头（它会被拼成文件名）',
    });
  }

  // apiKeyEnv 是环境变量名，写错了就永远读不到密钥，所以也校验。
  if (apiKeyEnv !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    problems.push({
      key: 'apiKeyEnv',
      message: '必须是一个合法的环境变量名（字母或下划线开头，只含字母、数字、下划线）',
    });
  }

  if (problems.length > 0) {
    throw new UsageError(formatProblems(configPath, source !== EMPTY_CONFIG, problems));
  }

  // 没有问题时 model 一定有值（缺失时上面已经报了错并抛出）。这里只是让类型收窄。
  if (model === undefined) {
    throw new UsageError(`配置里缺少 model：${configPath}`);
  }

  return {
    configPath,
    baseDir,
    vaultPathRaw,
    vaultPath: resolve(baseDir, vaultPathRaw),
    model,
    baseUrl,
    promptVersion,
    promptPath: resolve(baseDir, PROMPTS_DIR, `${promptVersion}.md`),
    maxInputChars,
    requestTimeoutMs,
    apiKeyEnv,
    apiKey: readApiKey(env, apiKeyEnv),
  };
}

/**
 * 取出密钥。没有就报错，并且把「怎么设置」直接写进错误信息里，
 * 而不是丢一句「缺少 API Key」让人自己去猜。
 */
export function requireApiKey(config: AppConfig): string {
  if (config.apiKey === undefined) {
    throw new UsageError(
      `没有找到 API Key（读的是环境变量 ${config.apiKeyEnv}）。\n` +
        `  cmd.exe 里临时设一个（只对当前窗口有效，等号两边不能有空格、值不加引号）：\n` +
        `    set ${config.apiKeyEnv}=你的密钥\n` +
        `  PowerShell 里：\n` +
        `    $env:${config.apiKeyEnv} = "你的密钥"\n` +
        `  想永久生效，设完重开终端：\n` +
        `    setx ${config.apiKeyEnv} 你的密钥\n` +
        `  注意：密钥只从环境变量读，不要写进 ${CONFIG_FILE_NAME}。`,
    );
  }
  return config.apiKey;
}

// ————————————————————————————— 内部实现 —————————————————————————————

/** 文件不存在时的占位。用同一个对象引用判断「有没有读到文件」。 */
const EMPTY_CONFIG: Record<string, unknown> = {};

/**
 * 读并解析配置文件。返回空对象表示「文件不存在或内容是空的」。
 * 抛 `UsageError` 表示「文件在那里，但根本读不了 / 不是合法 JSON」。
 */
function readConfigFile(configPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY_CONFIG;
    }
    throw new UsageError(`读不了配置文件：${configPath}\n  ${describeError(error)}`, {
      cause: error,
    });
  }

  // 记事本等 Windows 编辑器可能写入 BOM，JSON.parse 碰到它会直接失败。
  // 这属于「用户什么都没做错但程序炸了」，必须自己处理掉。
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.trim() === '') {
    return EMPTY_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `配置文件不是合法的 JSON：${configPath}\n  ${describeError(error)}\n` +
        `  提示：常见原因是多了一个逗号、少了引号，或者用了 // 注释（JSON 不支持注释）。`,
      { cause: error },
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`配置文件的顶层必须是一个 JSON 对象：${configPath}`);
  }

  return parsed as Record<string, unknown>;
}

function readNonEmptyString(
  source: Record<string, unknown>,
  key: string,
  problems: ConfigProblem[],
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    problems.push({ key, message: `必须是字符串，现在是 ${describeType(value)}` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    problems.push({ key, message: '不能是空字符串' });
    return undefined;
  }
  return trimmed;
}

function readPositiveInt(
  source: Record<string, unknown>,
  key: string,
  problems: ConfigProblem[],
): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    problems.push({
      key,
      message: `必须是大于 0 的整数，现在是 ${JSON.stringify(value)}`,
    });
    return undefined;
  }
  return value;
}

/**
 * 读一个网址。要求写完整体（含 `https://`），并且必须是 http/https。
 * 顺手去掉尾斜杠 —— 后面要拼 `/chat/completions`，`//` 这种地址有些服务端会拒。
 */
function readUrl(
  source: Record<string, unknown>,
  key: string,
  problems: ConfigProblem[],
): string | undefined {
  const value = readNonEmptyString(source, key, problems);
  if (value === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push({
      key,
      message: `必须是一个完整的网址（要带 https://），现在是 ${JSON.stringify(value)}`,
    });
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    problems.push({
      key,
      message: `只支持 http 与 https，现在是 ${parsed.protocol}`,
    });
    return undefined;
  }
  return value.replace(/\/+$/, '');
}

function readApiKey(env: NodeJS.ProcessEnv, apiKeyEnv: string): string | undefined {
  const value = env[apiKeyEnv];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 近似匹配，用来抓 `vault_path` / `VaultPath` / `modle` 这类笔误。
 * 只接受「差一两个字符」以内的候选，太远就宁可不说，免得指错方向。
 */
function suggestKey(unknown: string, known: readonly string[]): string | undefined {
  const normalize = (value: string): string => value.toLowerCase().replace(/[_-]/g, '');
  const target = normalize(unknown);

  let best: { key: string; distance: number } | undefined;
  for (const key of known) {
    const distance = editDistance(target, normalize(key));
    if (distance > 2) continue;
    if (best === undefined || distance < best.distance) best = { key, distance };
  }
  return best?.key;
}

/** 两行滚动数组版的最短编辑距离（增/删/改各算一步）。 */
function editDistance(a: string, b: string): number {
  const cell = (row: readonly number[], index: number): number => row[index] ?? 0;

  let previous: number[] = Array.from({ length: b.length + 1 }, (_unused, j) => j);
  let current: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitute = cell(previous, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(cell(previous, j) + 1, cell(current, j - 1) + 1, substitute);
    }
    [previous, current] = [current, previous];
  }

  return cell(previous, b.length);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
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

function formatProblems(
  configPath: string,
  fileExists: boolean,
  problems: readonly ConfigProblem[],
): string {
  const header = fileExists
    ? `配置文件有 ${problems.length} 处问题：\n  ${configPath}`
    : `还没有配置文件（它本身是可选的，但 model 没有默认值）：\n  ${configPath}\n` +
      `  想从头开始，复制一份模板：copy ${CONFIG_EXAMPLE_FILE_NAME} ${CONFIG_FILE_NAME}`;
  const lines = problems.map((problem) => `  · ${problem.key}：${problem.message}`).join('\n');
  return `${header}\n\n${lines}\n\n完整的字段说明见 docs/03-contracts.md 第 8 节。`;
}
