/**
 * 调模型 → 校验 → 不合格就带着错误重试（契约第 4.1–4.4 节，写入时机见 6.1）。
 *
 * 这是「AI 整理」真正发生的地方。三条设计要点：
 *
 * 1. **校验失败才重试，网络失败不重试。**
 *    这两种失败长得像，处理方式却相反：模型回了但形状不对，把「哪里不对」告诉它，
 *    它多半能改对；而连不上、超时、Key 不对，用同样的请求再打一遍只会得到同样的结果，
 *    代价是你多等两三倍的时间。所以 `LlmError` 直接往外抛。
 *
 * 2. **重试时把上一次的原始产出放回上下文。**
 *    只说「你错了」而不给模型看它自己写了什么，它会重新猜一遍（往往猜出同一个错）。
 *
 * 3. **原始产出一个字都不丢。**
 *    不管成功失败，模型到底回了什么都要跟着结果一起返回——T11 要把它写进 `quarantine/`。
 *    这是排查「为什么这条笔记整理成这样」唯一有用的东西，丢了就再也拿不回来。
 *
 * 本文件属于 core：不碰文件、网络、时间、随机数。网络是 `chat` 参数带进来的。
 */

import type { AnalyzeResult, ChatFunction, ChatMessage, ChatUsage } from './contracts.js';
import { ValidationError, describeError } from './errors.js';
import { assembleSystemMessage } from './prompt.js';
import { formatProblems, validateAnalyzeResult } from './validate.js';

/**
 * 失败后最多再试几次。**默认 2 次，也就是最多调用模型 3 次。**
 * 每次重试都是真金白银，所以这个数字不能随手调大。
 */
export const DEFAULT_MAX_RETRIES = 2;

export interface AnalyzeOptions {
  /** 提示词模板的**原文**（还没替换占位符）。读文件是调用方的事。 */
  template: string;
  /** 已有标签词表，会注入到提示词的占位符处。 */
  tags: readonly string[];
  /** 用户原文（已规范化的文本）。 */
  input: string;
  /** 发对话的函数。测试时塞一个假的进来。 */
  chat: ChatFunction;
  maxRetries?: number;
}

export interface AnalyzeOutcome {
  result: AnalyzeResult;
  /** 最后一次的原始回应，原样。 */
  rawOutput: string;
  /** 所有尝试累计的用量。供应商没返回时为 undefined。 */
  usage: ChatUsage;
  /** 所有尝试累计的耗时。 */
  latencyMs: number;
  /** 实际调用了几次（1 表示一次就过）。 */
  attempts: number;
  /** 供应商报告的模型名，拿不到时是空字符串。 */
  model: string;
}

/** 跑一次完整的分析。模板有问题时抛 `UsageError`（此时**还没发过任何请求**）。 */
export async function analyze(options: AnalyzeOptions): Promise<AnalyzeOutcome> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const totalAttempts = maxRetries + 1;

  const system = assembleSystemMessage(options.template, options.tags);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: options.input },
  ];

  let usage: ChatUsage = {};
  let latencyMs = 0;
  let model = '';
  let rawOutput = '';
  const rawOutputs: string[] = [];
  let lastFeedback = '';

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    // 网络错误在这里直接向外抛（退出码 4），不进入下面的重试。
    const reply = await options.chat(messages);

    latencyMs += reply.latencyMs;
    usage = addUsage(usage, reply.usage);
    if (reply.model !== '') model = reply.model;
    rawOutput = reply.text;
    rawOutputs.push(reply.text);

    const outcome = inspect(rawOutput);
    if (outcome.ok) {
      return {
        result: outcome.result,
        rawOutput,
        usage,
        latencyMs,
        attempts: attempt,
        model,
      };
    }

    lastFeedback = outcome.feedback;

    if (attempt < totalAttempts) {
      messages.push({ role: 'assistant', content: rawOutput });
      messages.push({
        role: 'user',
        content:
          '你上一次的输出没有通过校验，程序拒绝了它。问题如下：\n\n' +
          `${lastFeedback}\n\n` +
          '请重新输出**完整的** JSON 对象（不是补丁、不是片段），把上面每一处都改掉。',
      });
    }
  }

  throw new ValidationError(
    `模型连续 ${String(totalAttempts)} 次返回的内容都不合契约。最后一次的问题：\n` +
      `${lastFeedback}\n\n` +
      `  模型的原始产出已经保留下来了（${String(rawOutputs.length)} 次都在），不会丢。`,
    { rawOutput, rawOutputs, attempts: totalAttempts },
  );
}

// ————————————————————————————— 内部实现 —————————————————————————————

type Inspection = { ok: true; result: AnalyzeResult } | { ok: false; feedback: string };

/** 把一段原始回应判成「可以用了」或者「哪里不对」。 */
function inspect(rawText: string): Inspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapCodeFence(rawText));
  } catch (error) {
    return {
      ok: false,
      feedback:
        `整个回复不是一个能被 JSON.parse 解析的对象：${describeError(error)}\n` +
        `  记住：只输出 JSON 本身，不加代码围栏、不加任何解释或开场白。`,
    };
  }

  const validation = validateAnalyzeResult(parsed);
  if (validation.ok) return { ok: true, result: validation.result };
  return { ok: false, feedback: formatProblems(validation.problems) };
}

/**
 * 容忍最外层那一层代码围栏。
 *
 * 提示词明令禁止围栏，但模型偶尔还是会给。这里**不代表契约放宽了**——只是把
 * 「多包了一层壳」和「内容不对」分开：能剥掉就剥掉，没必要为了一层壳花钱重试一次。
 * 只在最外层有围栏时才剥，正文里出现的 ``` 一律不动。
 */
function unwrapCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;

  const withoutOpen = trimmed.replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n/, '');
  if (withoutOpen === trimmed) return text; // ``` 后面没有换行，多半不是围栏

  const closeAt = withoutOpen.lastIndexOf('```');
  return closeAt === -1 ? withoutOpen : withoutOpen.slice(0, closeAt);
}

/** 累加用量。两边都没给数字时保持「不知道」，不要造一个 0 出来。 */
function addUsage(total: ChatUsage, delta: ChatUsage): ChatUsage {
  const result: ChatUsage = {};
  const hasInput = total.inputTokens !== undefined || delta.inputTokens !== undefined;
  const hasOutput = total.outputTokens !== undefined || delta.outputTokens !== undefined;

  if (hasInput) result.inputTokens = (total.inputTokens ?? 0) + (delta.inputTokens ?? 0);
  if (hasOutput) result.outputTokens = (total.outputTokens ?? 0) + (delta.outputTokens ?? 0);
  return result;
}
