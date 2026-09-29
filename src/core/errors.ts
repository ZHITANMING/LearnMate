/**
 * 错误类型与退出码。
 *
 * 退出码是**对外契约**，定义在 docs/03-contracts.md 第 7 节：
 *   0 成功（含「已存在，跳过」与「用户取消」）
 *   1 未预期错误
 *   2 用法 / 配置错误（保证不产生任何写入）
 *   3 输出校验失败（现场进 quarantine/）
 *   4 外部服务错误（网络、超时、限流、鉴权）
 *
 * 本文件属于 core：纯数据 + 纯函数，不碰文件、网络、时间。
 */

export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  VALIDATION: 3,
  LLM: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * 所有「已经知道该怎么办」的错误的基类。
 *
 * 区别在于：普通 `Error` 意味着「出了我不知道的事」，程序只能打印堆栈、退出 1；
 * 而 `LearnMateError` 意味着「这是个分类清楚的问题」，程序知道该给用户看什么、
 * 该返回哪个退出码、该不该保留现场。
 */
export class LearnMateError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/**
 * 参数写错、配置缺失、输入超长……都属于这一类。
 * 退出码 2，且**保证不产生任何写入**。
 */
export class UsageError extends LearnMateError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, EXIT.USAGE, options);
  }
}

/**
 * 校验失败：模型确实回应了，但回应的东西不合契约
 * （不是 JSON、字段越界、块类型不认识、标题重复……）。
 *
 * 退出码 3。现场（用户原文 + 模型的**原始产出**）必须进 quarantine/。
 * 把模型的原始产出挂在错误对象上，是因为「它到底回了什么」是排查这类问题时
 * 唯一有用的东西，而它一旦被丢掉就再也拿不回来了。
 */
export class ValidationError extends LearnMateError {
  /** 最后一次的原始回应。空字符串表示「根本没拿到回应」。 */
  readonly rawOutput: string;
  /** **每一次**的原始回应，按顺序。失败时一次都不丢——这是排查提示词问题唯一的线索。 */
  readonly rawOutputs: readonly string[];
  /** 一共试了几次（含最后一次）。 */
  readonly attempts: number;

  constructor(
    message: string,
    options: { rawOutput: string; rawOutputs?: readonly string[]; attempts: number; cause?: unknown },
  ) {
    super(message, EXIT.VALIDATION, { cause: options.cause });
    this.rawOutput = options.rawOutput;
    this.rawOutputs = options.rawOutputs ?? [options.rawOutput];
    this.attempts = options.attempts;
  }
}

/**
 * 模型的输出**通过了**契约校验，但没法安全落盘。
 *
 * 目前只有一种情况会走到这里：同一次输入里有两条标题相同的笔记，算出来的目标
 * 文件名一模一样——写出第二份就等于静默抹掉第一份。
 *
 * 为什么不复用 `ValidationError`：那种情况要保住的是「模型到底回了什么」（原始产出），
 * 这种情况的输出是**完全合法**的，问题出在文件名上，两者要留给用户的现场不一样。
 *
 * 退出码仍然是 3：它属于「输出不能被安全地写成文件」这一族。不能用 2——退出码 2
 * 承诺「不产生任何写入」，而走到这一步时 `raw/` 与 `draft/` 早就写下去了。
 */
export class UnsafeWriteError extends LearnMateError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, EXIT.VALIDATION, options);
  }
}

/**
 * 外部服务错误：网络断了、超时、限流、Key 不对、服务端 5xx。
 *
 * 退出码 4。**这类错误不重试** —— 拿同一个请求再打一遍，结果只会是同样的失败，
 * 代价却是让你多等几分钟。要重试也应该在更上一层做退避，而不是在这里立刻重发。
 */
export class LlmError extends LearnMateError {
  /** HTTP 状态码。没走到 HTTP 那一步（超时、DNS 失败）时为 undefined。 */
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, EXIT.LLM, { cause: options?.cause });
    this.status = options?.status;
  }
}

/**
 * 把任意异常翻译成退出码。
 * 不认识的异常一律算「未预期」（1）—— 绝不静默吞掉。
 */
export function toExitCode(error: unknown): ExitCode {
  return error instanceof LearnMateError ? error.exitCode : EXIT.UNEXPECTED;
}

/** 取一个异常的人类可读描述，用于拼错误信息。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
