/**
 * 全项目**唯一**会发网络请求的地方。
 *
 * 它只负责「把一段对话发出去，把回应的正文和用量拿回来」。它**不解析 JSON**，
 * 也不判断结果对不对——那是 `src/core/analyze.ts` 的事。这个分工是刻意的：
 *
 *   网络错误（连不上、超时、限流、Key 不对）→ 退出码 4，**重试没有意义**；
 *   契约错误（回了但回的不是我们要的形状）  → 退出码 3，**重试有意义**（把错误回喂给模型）。
 *
 * 如果在这里顺手 `JSON.parse`，这两类错误就会挤进同一个 catch，
 * 然后我们会忍不住把「Key 填错了」也重试两遍。
 */

import { LlmError, describeError } from '../core/errors.js';
import type { ChatFunction, ChatMessage, ChatReply, ChatUsage } from '../core/contracts.js';

export interface LlmClientOptions {
  /** 不含尾斜杠，例如 `https://api.deepseek.com/v1`。请求打到 `<baseUrl>/chat/completions`。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 测试用：换成假的 fetch。不传就用全局的。 */
  fetchImpl?: typeof fetch;
}

/**
 * 温度固定 0。
 *
 * 这不是「调参」——同一个原文重跑两次得到不同的笔记，会让 `source_hash` 查重、
 * `reprocess`、以及「我刚才那条为什么和上次不一样」全部变成无法回答的问题。
 * 模型本身仍可能有非确定性，但我们不该主动往里再加。
 */
const TEMPERATURE = 0;

/**
 * 让供应商保证输出是 JSON 对象。
 *
 * 这是 OpenAI 兼容协议的一个可选字段。理论上它可能被某些自建服务拒绝——真遇到时
 * 需要把它变成配置项。DeepSeek 支持它，所以先写死。
 */
const RESPONSE_FORMAT = { type: 'json_object' } as const;

/** 出错时展示的响应体上限，防止把一大坨 HTML 错误页全打印出来。 */
const BODY_PREVIEW_MAX = 500;

/**
 * 把一份传输层配置包成一个「发对话」的函数。
 *
 * 调用方（命令层）在启动时建一次，然后把它当参数交给 `core/analyze.ts`——
 * 于是 analyze 完全不需要知道 baseUrl、Key、超时这些东西的存在。
 */
export function createChatFunction(options: LlmClientOptions): ChatFunction {
  return (messages) => send(options, messages);
}

/** 真正发请求。失败一律抛 `LlmError`（退出码 4）。 */
async function send(
  options: LlmClientOptions,
  messages: readonly ChatMessage[],
): Promise<ChatReply> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  const startedAt = Date.now();

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          // 这个头里带着密钥。**任何日志、错误信息、异常堆栈都不许把它打出来。**
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          temperature: TEMPERATURE,
          response_format: RESPONSE_FORMAT,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LlmError(
          `模型服务没有在 ${String(options.timeoutMs)} 毫秒内回应，请求已取消。\n` +
            `  地址：${url}\n` +
            `  常见原因：网络慢、原文太长、或者对方正在排队。\n` +
            `  想等久一点，把 learnmate.config.json 里的 requestTimeoutMs 调大。`,
          { cause: error },
        );
      }
      throw new LlmError(
        `连不上模型服务。\n  地址：${url}\n  ${describeCause(error)}\n` +
          `  检查：网络通不通、baseUrl 写对没有、需不需要代理。`,
        { cause: error },
      );
    }

    const bodyText = await readBody(response);
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      throw new LlmError(describeHttpFailure(response.status, bodyText, url), {
        status: response.status,
      });
    }

    return { ...parseCompletion(bodyText, url), latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

// ————————————————————————————— 内部实现 —————————————————————————————

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    // 读不出正文不算致命：状态码本身已经足够说明问题。
    return '';
  }
}

function describeHttpFailure(status: number, bodyText: string, url: string): string {
  const detail = extractProviderMessage(bodyText);
  const head = `模型服务返回了 ${String(status)}（${url}）`;
  const tail = detail === undefined ? '' : `\n  对方说：${detail}`;

  if (status === 401 || status === 403) {
    return (
      `${head}${tail}\n` +
      `  这通常意味着 API Key 不对、过期或没有权限。\n` +
      `  密钥只从环境变量读，检查 learnmate.config.json 里的 apiKeyEnv 指定的是哪一个变量名。`
    );
  }
  if (status === 429) {
    return (
      `${head}${tail}\n` +
      `  被限流了。等一会儿再跑；如果经常这样，检查账户余额和并发限制。\n` +
      `  （同一个请求立刻重发只会再撞一次，所以这里不自动重试。）`
    );
  }
  if (status === 400 || status === 422) {
    return (
      `${head}${tail}\n` +
      `  请求本身被拒绝了。常见原因：model 名字写错、账户余额不足、\n` +
      `  或者这个服务不支持 response_format 参数。`
    );
  }
  if (status >= 500) {
    return `${head}${tail}\n  是对方服务器出的问题，不是你这边。稍后重试。`;
  }
  return `${head}${tail}`;
}

/** 从错误响应里尽量挖出一句人话。挖不到就算了，不要自己编。 */
function extractProviderMessage(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (trimmed === '') return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>)['error'];
      if (typeof error === 'string') return truncate(error);
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>)['message'];
        if (typeof message === 'string') return truncate(message);
      }
      const message = (parsed as Record<string, unknown>)['message'];
      if (typeof message === 'string') return truncate(message);
    }
  } catch {
    // 不是 JSON：直接当初文本文用。
  }
  return truncate(trimmed);
}

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= BODY_PREVIEW_MAX
    ? collapsed
    : `${collapsed.slice(0, BODY_PREVIEW_MAX)}…（后面还有 ${String(collapsed.length - BODY_PREVIEW_MAX)} 个字符）`;
}

/**
 * 拆开一层成功的响应信封，取出正文与用量。
 * 信封本身不符合协议时抛 `LlmError` —— 那是对方的问题，不是模型的「输出不合契约」。
 */
function parseCompletion(bodyText: string, url: string): Omit<ChatReply, 'latencyMs'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    throw new LlmError(
      `模型服务返回的不是 JSON（${url}）。\n  ${describeError(error)}\n` +
        `  原文开头：${truncate(bodyText) || '（空）'}`,
      { cause: error },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new LlmError(`模型服务的回应不是一个 JSON 对象（${url}）。`);
  }

  const record = parsed as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmError(
      `模型服务的回应里没有 choices（${url}）。\n  原文：${truncate(bodyText) || '（空）'}`,
    );
  }

  const first = choices[0];
  const message =
    typeof first === 'object' && first !== null
      ? (first as Record<string, unknown>)['message']
      : undefined;
  const content =
    typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>)['content']
      : undefined;

  if (typeof content !== 'string') {
    throw new LlmError(
      `模型服务的回应里没有正文（choices[0].message.content）（${url}）。\n` +
        `  原文：${truncate(bodyText) || '（空）'}`,
    );
  }

  return {
    text: content,
    usage: readUsage(record['usage']),
    model: typeof record['model'] === 'string' ? record['model'] : '',
  };
}

function readUsage(value: unknown): ChatUsage {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const usage: { inputTokens?: number; outputTokens?: number } = {};

  const input = record['prompt_tokens'];
  if (typeof input === 'number') usage.inputTokens = input;
  const output = record['completion_tokens'];
  if (typeof output === 'number') usage.outputTokens = output;

  return usage;
}

/** 把 `fetch failed` 底下那层真正的原因（`ENOTFOUND`、`ECONNREFUSED`…）也说出来。 */
function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== '') {
    return `${error.message}（${cause.message}）`;
  }
  return error.message;
}
