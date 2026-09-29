/**
 * 数据契约的唯一定义处。
 *
 * 这里是整个项目里唯一「只有类型、没有逻辑」的模块。按照架构的硬约束，
 * 它不能 import 任何东西——一旦它开始依赖别的模块，所有模块都会被迫依赖那个模块，
 * 「契约」就不再是所有人都能引用的中立地带了。
 *
 * 字段约束（长度、枚举、数量）写在 docs/03-contracts.md 里，由 core/analyze.ts
 * 在模型返回后校验。这里只固定形状。
 */

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

/** 笔记的主要语言。决定正文里那些默认标题用中文还是英文。 */
export type Language = 'zh' | 'en';

/**
 * 笔记的阅读状态。
 *
 * `inbox` 表示用户用 --yes 跳过了预览，还没过目；
 * `processed` 表示用户预览后确认过；
 * `reviewed` v0.1 不写入，为将来的复习闭环预留（见契约第 3.2 节）。
 */
export type NoteStatus = 'inbox' | 'processed' | 'reviewed';

/* ------------------------------------------------------------------ *
 * NoteDraft：模型被允许产出的全部东西
 * ------------------------------------------------------------------ */

/** 普通段落。没有标题，用来放概述、前置条件、背景。 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 有序列表。渲染成 `## {title}` + `1.` `2.` … */
export interface StepsBlock {
  type: 'steps';
  /** 省略或为空时使用默认标题（见 render.ts）。 */
  title?: string;
  items: string[];
}

/** 无序列表。渲染成 `## {title}` + `-` 列表。 */
export interface ListBlock {
  type: 'list';
  title?: string;
  items: string[];
}

/** 参数表格里的一行。 */
export interface ParamItem {
  name: string;
  /** 取值。允许为空——参数名本身也是有用的信息。 */
  value?: string;
  /** 备注，例如「乙插件」。允许为空。 */
  note?: string;
}

/** 参数速查表。渲染成 `## {title}` + 三列表格。 */
export interface ParamsBlock {
  type: 'params';
  title?: string;
  items: ParamItem[];
}

/** 术语解释。渲染成 `### {term}` + 段落，**不产生 `##` 标题**。 */
export interface ConceptBlock {
  type: 'concept';
  term: string;
  explanation: string;
}

/** 一条拿不准的内容，以及拿不准的原因。 */
export interface UncertainItem {
  /** 原文里那段话（或模型对它的转述）。 */
  text: string;
  /** 为什么拿不准。必填——只说「不确定」而说不出原因的，多半是模型在偷懒。 */
  reason: string;
  /** 用户在预览时选择「我来改写」后填写的更正内容。渲染成 `- 更正为：…`。 */
  resolution?: string;
}

/**
 * 拿不准的内容。**整篇至多一个**，且无论它在 `blocks` 里排第几，
 * 渲染时一律挪到文末的 `## 待确认`。
 */
export interface UncertainBlock {
  type: 'uncertain';
  items: UncertainItem[];
}

/** 正文的积木。模型无权发明新类型——这是「受控」的全部含义。 */
export type Block =
  | TextBlock
  | StepsBlock
  | ListBlock
  | ParamsBlock
  | ConceptBlock
  | UncertainBlock;

/**
 * 一条笔记的草稿。**这是模型唯一被允许产出的形状，它不许写 Markdown。**
 *
 * Markdown 永远由 core/render.ts 从这份草稿确定性生成，理由是：
 * 模型直接写 Markdown 无法校验、两次运行格式会漂移、改模板要重调模型、
 * 也没法做字段级 diff。
 */
export interface NoteDraft {
  /** 1–80 字符，单行。 */
  title: string;
  /** 1–300 字符，单行。渲染成 `> {summary}` 引用块。 */
  summary: string;
  language: Language;
  /** 1–5 项，每项 1–20 字符。 */
  tags: string[];
  /** 1–12 个。 */
  blocks: Block[];
}

/** 一次输入的分析结果：0–15 条笔记（见契约 4.1：0 条是最后手段）。 */
export interface AnalyzeResult {
  notes: NoteDraft[];
}

/* ------------------------------------------------------------------ *
 * 模型对话：core/analyze.ts 与 io/llm.ts 之间的那道边界
 * ------------------------------------------------------------------ */

/**
 * 一条对话消息。
 *
 * `assistant` 是给重试用的：上一次的产出不合契约时，要把它连同「哪里不对」一起放回上下文，
 * 模型才改得准。只说「你错了」而不给它看自己写了什么，它会重新猜一遍（往往猜出同一个错）。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 一次调用的用量。供应商没返回时字段为 undefined——不要用 0 冒充「没花钱」。 */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** 一次调用的结果。 */
export interface ChatReply {
  /** 模型回应的正文，**原样**。可能是合法 JSON，也可能不是。 */
  text: string;
  usage: ChatUsage;
  latencyMs: number;
  /** 供应商实际使用的模型名。拿不到时是空字符串。 */
  model: string;
}

/**
 * 「发一段对话，拿回一段回应」。
 *
 * `core/analyze.ts` 只认这个形状，**不认识** baseUrl、API Key、超时——
 * 那些都是传输层的事。接口定义在 contracts 里而不是 io 里，是为了让 core 不依赖 io：
 * core 定义自己需要什么，io 去满足它（TypeScript 的结构化类型天然支持这一点）。
 */
export type ChatFunction = (messages: readonly ChatMessage[]) => Promise<ChatReply>;

/* ------------------------------------------------------------------ *
 * NoteMeta：frontmatter 里那些不由模型决定的字段
 * ------------------------------------------------------------------ */

/**
 * 一条笔记的元数据。
 *
 * 这里的时间戳由调用方传入，**不是** render 自己去读时钟——render 必须保持纯函数，
 * 同样的输入永远得到逐字节相同的输出（见契约第 3.3 节第 7 条）。
 */
export interface NoteMeta {
  /** 26 字符大写 ULID。 */
  id: string;
  /**
   * 本次输入的 id。**同一次输入拆出的所有笔记共享它。**
   *
   * 它出现在 frontmatter 里，是为了让笔记文件**自给自足**：`raw/<input_id>.txt` 与
   * `draft/<input_id>.json` 都是按它命名的，只拿到 `notes/` 也得能找回去。
   * 否则台账一旦丢失，`reprocess` 就再也找不到那条笔记的原文和草稿了。
   */
  inputId: string;
  /** ISO 8601 带时区偏移，例如 `2026-09-28T21:31:26+08:00`。 */
  created: string;
  /** 同上。重处理时更新。 */
  updated: string;
  status: NoteStatus;
  /** `sha256:` + 64 位小写十六进制。一次输入拆出的所有笔记共享同一个值。 */
  sourceHash: string;
  /**
   * 来源标识。**只存文件名，绝不存完整路径**——完整路径会泄露用户名和目录结构，
   * 笔记一旦被分享或同步就跟着出去了。
   */
  sourceRef?: string;
  /** 当前为 1。 */
  schemaVersion: number;
  /** 生成该笔记的模型标识，例如 `deepseek-chat`。 */
  model: string;
  /** 生成该笔记的提示词版本，例如 `analyze.v1`。 */
  promptVersion: string;
}

/* ------------------------------------------------------------------ *
 * 台账：磁盘上的 JSONL 格式
 * ------------------------------------------------------------------ */

/**
 * 一条台账记录的结局。
 *
 * `ok` 是唯一代表「这条笔记真的写进 `notes/` 了」的值——查重只认它。
 * 其余几种都是「留下了痕迹，但没有产出笔记」，留着是为了能回答
 * 「我那次输入到底怎么了」。
 */
export type LedgerOutcome =
  | 'ok'
  | 'skipped'
  | 'duplicate'
  | 'cancelled'
  | 'validation_failed'
  | 'llm_error'
  /** 模型说原文里没有可整理的（出口 5）。与 `skipped` 是两件事：这是**模型的判断**。 */
  | 'empty'
  /** 目标文件名撞名，整批不写（出口 7）。 */
  | 'unsafe_write';

/** 非 `ok` 行的结局。**读取端必须认得每一个**——`duplicate` 是历史值，见下。 */
export type LedgerInputOutcome = Exclude<LedgerOutcome, 'ok'>;

/**
 * 真的会被**写出来**的非 `ok` 结局。
 *
 * 比 `LedgerInputOutcome` 少一个 `duplicate`：命中查重时 `add` 是「成功了但什么都没发生」，
 * 不写台账行（契约 §9.3 出口 2）。但那个枚举值保留定义、读取端继续认它——
 * 历史文件里可能有。这个类型让「不会产生 `duplicate`」变成编译器能检查的事实。
 */
export type LedgerRecordableOutcome = Exclude<LedgerInputOutcome, 'duplicate'>;

/**
 * 台账里的**笔记行**：一次输入产出 N 条笔记 → 写 N 行，每行都带同一个 `input_id`。
 * 字段与 T10 之前逐字相同（契约 §9.0.1）。
 *
 * 字段名用 snake_case，因为这是磁盘上的文件格式（契约第 9 节），
 * 不是内存里的对象。改字段名等于改文件格式，要走契约变更流程。
 */
export interface LedgerNoteRow {
  /** ISO 8601 时间戳。 */
  ts: string;
  input_id: string;
  /** 本条笔记的 id。 */
  id: string;
  /** 本批中的序号，从 1 开始。 */
  note_index: number;
  /** 本批一共几条。 */
  note_total: number;
  source_hash: string;
  /** 相对知识库根的路径，例如 `notes/示例笔记-01j8zq7v.md`。 */
  note_path: string;
  title: string;
  tags: string[];
  /** 写出时的状态。 */
  status: string;
  model: string;
  prompt_version: string;
  /** 用量。供应商没返回时为 0。 */
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  /** 存疑项总数。 */
  uncertain_total: number;
  /** 用户选择保留的数量。 */
  uncertain_kept: number;
  /** 固定值，也是判别两种行的依据。 */
  outcome: 'ok';
}

/**
 * 台账里的**输入行**：**一行 = 一次输入**，记的是「这次输入落了个什么结局」（契约 §9.0.2）。
 *
 * 它不指向任何一条笔记，所以**没有** `id` / `note_index` / `note_path` / `title` /
 * `tags` / 用量 / 存疑这些字段——不是「填了零值」，是这一行根本没有这些东西。
 * 判别联合的存在就是为了让这件事在类型上说出来，而不是靠读的人去猜空字符串是什么意思。
 */
export interface LedgerInputRow {
  /** ISO 8601 时间戳。 */
  ts: string;
  input_id: string;
  source_hash: string;
  model: string;
  prompt_version: string;
  outcome: LedgerInputOutcome;
  /** 给用户看的一句话（已压成单行并截断）。程序**不解析**它，只拿它当说明。 */
  reason: string;
  /** 这次输入拆出了几条草稿；模型没答上来时为 0（例如 `validation_failed`）。 */
  draft_total: number;
  /** 用户按 `n` 跳过了几条。**只有 `skipped` 与 `cancelled` 有**这个字段。 */
  skipped_total?: number;
}

/**
 * 台账里的一行。两种形状按 `outcome` 判别：
 * 先看 `entry.outcome === 'ok'`，就知道该按哪一种去读它。
 */
export type LedgerEntry = LedgerNoteRow | LedgerInputRow;

/* ------------------------------------------------------------------ *
 * frontmatter：从磁盘上的笔记文件里读回来的形状
 * ------------------------------------------------------------------ */

/**
 * 一条笔记的 frontmatter，字段名与文件里一致（snake_case）。
 *
 * 与 `NoteMeta` 是**两个方向**的东西：`NoteMeta` 是写出去时用的（camelCase，内存里），
 * 这个是读回来时用的（snake_case，和文件逐字段对应）。不要合并它们——
 * 合并之后「改内存里的名字」会顺手改掉文件格式。
 */
export interface NoteFrontmatter {
  id: string;
  /** 可选，因为 `input_id` 是后加的字段，早期笔记文件里可能没有。 */
  input_id?: string;
  title: string;
  created: string;
  updated: string;
  summary: string;
  tags: string[];
  status: string;
  source_hash: string;
  source_ref?: string;
  schema_version: number;
  language: string;
  model: string;
  prompt_version: string;
}

/**
 * 一条笔记的「摘要视图」：文件在哪 + 读回来的 frontmatter（或者为什么读不懂）。
 *
 * 这是 `list` / `show` 这两个只读命令的数据形状。它和另外两个都不同：
 * `NoteMeta` 是**写出去**时用的（camelCase），`NoteFrontmatter` 是**读回来**的那一半，
 * 而它多带了两件只读命令必须要有的东西——「这个文件在哪」，以及
 * 「读不懂的话是哪里不对」。后者的存在是为了**不许静默吞掉坏文件**：
 * 一篇读不懂的笔记照样要出现在列表里，只是标出来（契约 §11）。
 */
export interface NoteSummary {
  /** 绝对路径。给程序用。 */
  path: string;
  /** 相对知识库根目录的路径，正斜杠分隔。给人看。 */
  relativePath: string;
  /** 读不懂时为 `null`——文件还在，只是解析不出来。 */
  frontmatter: NoteFrontmatter | null;
  /** 读不懂的原因。只有 `frontmatter === null` 时才有。 */
  problem?: string;
}

/* ------------------------------------------------------------------ *
 * 存疑项裁定：用户当年在预览里做的 d/e，落到 resolutions/<input_id>.json（T13）
 * ------------------------------------------------------------------ */

/**
 * 用户对一条存疑项做的裁定。
 *
 * 只有 `drop` 与 `edit` 会被记下来：`keep` 是默认值，一条非 `keep` 都没有时
 * 整个裁定文件根本不存在（契约 §12.4）。所以「文件里没有这一条」与
 * 「文件里写着 keep」是同一件事，不需要为此多一种取值。
 */
export type UncertainRulingAction = 'drop' | 'edit';

/**
 * 一条存疑项的一次裁定。
 *
 * 带两个坐标：`item_index` 用来定位（重放时按下标找），`text` 用来**校验**
 * （对不上说明这个文件被手工改过，或者草稿换了——那就降级按 `keep`，绝不硬套）。
 */
export interface UncertainRuling {
  /** 1 起，对应草稿里这篇笔记的第几条存疑项（用户当初看到的编号）。 */
  item_index: number;
  /** 裁定发生时那一条存疑项的原文。重放前拿它和草稿比对。 */
  text: string;
  action: UncertainRulingAction;
  /** 只有 `action === 'edit'` 才有：用户自己写的那一句更正。 */
  resolution?: string;
}

/** 一篇笔记上的全部裁定。 */
export interface NoteRulings {
  /** 1 起，对应草稿 `notes` 数组里的第几条。 */
  note_index: number;
  items: UncertainRuling[];
}

/**
 * `vault/.learnmate/resolutions/<input_id>.json` 的内容。
 *
 * **不改 `draft/`。** `draft/` 是「模型到底回了什么」的证据，用户的裁定
 * 是另一件事，另存一份文件。这样同一份草稿永远只有模型一个作者。
 */
export interface ResolutionFile {
  input_id: string;
  /** ISO 8601 时间戳，写这份裁定的时刻。 */
  ts: string;
  notes: NoteRulings[];
}

/** `parseResolutionFile` 的结果：要么是合法的裁定文件，要么是为什么不认它。 */
export type ResolutionParse =
  | { ok: true; file: ResolutionFile }
  | { ok: false; problems: readonly string[] };

/**
 * `applyRulings` 的结果。它**不做 IO**，只说「这些裁定套到这份草稿上会变成什么」，
 * 以及套的过程中有哪些地方对不上（`warnings`，调用方负责打给用户看）。
 */
export interface RulingApplication {
  /** 套完裁定之后的**新**草稿；传进来的那份一个字段都不动。 */
  draft: NoteDraft;
  /** 对不上、被降级成 `keep` 的那些，一句话一条。空数组＝全部套上了。 */
  warnings: string[];
  /** 真正落地的裁定数（`drop` + `edit`），不含被降级的。 */
  applied: number;
}
