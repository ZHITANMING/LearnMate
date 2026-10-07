# 02 · 架构

> 这份文档回答一个问题：**代码分成哪几块、谁可以调用谁、数据怎么流动。**
> 数据结构长什么样见 [03-contracts.md](03-contracts.md)；每个决定的理由见 [decisions.md](decisions.md)。

## 三条核心原则

这三个原则解释了后面所有的设计。如果某个设计让你困惑，回到这里。

**① 模型与视图分离。**
大模型**只被允许产出结构化数据**（一个 JSON 对象），永远不许直接写 Markdown。
Markdown 由一个确定性函数从那个 JSON 生成。

为什么不省这一步：如果让模型直接写 Markdown，你就没法校验它、没法把它变成别的格式、
改一次排版就要重调模型、也没法做字段级对比。而 JSON 可以被程序逐字段检查。

**② 知识库可重建。**
知识库的真相来源是 **Markdown 文件 + 原始文本**，其它一切都是派生物。
台账（`ledger.jsonl`）删掉没关系，可以用一条命令从 `notes/` 目录重建。
这条原则保证你永远不会被自己的工具绑架。

**③ 原文永不丢失。**
调用大模型之前，**先把原始文本落盘**。这是整个流程里唯一一个不可跳过、不可撤销的动作。
模型超时也好、返回一堆废话也好、你自己中途按了取消也好，原文都已经在磁盘上了。

## 模块划分

| 文件 | 模块 | 职责 | 允许碰 IO 吗 |
| --- | --- | --- | --- |
| `src/main.ts` | cli | 解析命令行参数、调用 pipeline、打印人类可读的结果、预览确认交互、把异常翻译成退出码 | 是（只是个壳） |
| `src/commands/*.ts` | 各子命令 | 每个子命令的参数定义与入口 | 是 |
| `src/config.ts` | config | 读 `learnmate.config.json` 和环境变量、填默认值、校验必填项 | 是 |
| `src/pipeline.ts` | pipeline | **唯一知道完整流程的地方**，负责顺序、失败分流、`--dry-run` | 是（编排者） |
| `src/core/contracts.ts` | contracts | 所有类型的唯一定义处 + 运行期校验用的 schema | **否**，且不依赖任何第三方类型 |
| `src/core/ingest.ts` | ingest | 文本规范化、sha256 指纹、长度守卫 | **否** |
| `src/core/analyze.ts` | analyze | 组装提示词、调用 llm、校验返回结果、失败重试 | **否**（大模型调用通过参数传进来） |
| `src/core/render.ts` | render | `NoteDraft` + 元数据 → Markdown 字符串 | **否** |
| `src/io/vault.ts` | vault | 知识库文件系统：拼路径、清洗文件名、原子写、读写 raw/draft/notes、回收站、扫描 | 是 |
| `src/io/ledger.ts` | ledger | 追加式台账：指纹查重 + 运行审计 | 是 |
| `src/io/llm.ts` | llmClient | 一个方法：给它消息和 JSON schema，拿回已解析的对象和用量 | 是 |
| `src/io/readers/*.ts` | readers | 把别的格式抽成纯文本（现在只有 `docx.ts`），**只读不写**；输出接着走 `ingest`，下游看不见格式差异 | 是 |
| `src/util/*.ts` | 小工具 | 被多处复用的纯工具（`hash.ts`、`slug.ts`）。只有 `id.ts` 例外——它生成 ULID，需要当前时间和随机数 | 部分 |

### 关于 `util/id.ts` 的一个说明

早先的设计把「生成 ULID」放在了 `core/ingest.ts` 里，这跟「core 不许碰时间与随机数」
直接冲突。修法是：**core 的函数不自己生成 id，而是把它作为参数收进来**；
真正生成 id 的 `util/id.ts` 待在 core 外面，由 `pipeline` 调用后传进去。

这样 `ingest` 和 `render` 依然是纯函数：给它同样的输入（包括 id 和时间），它给你
一模一样的结果。

## 依赖方向

只能从上往下。**箭头反过来就是架构被破坏了。**

```
                    main.ts（cli）
                         │
                    commands/*.ts
                         │
                    pipeline.ts ─────────────┐
                    ╱    │    │    ╲          │
             ingest  analyze render  vault  ledger
                │        │              ▲
              util     io/llm ──────────┘
                         │
                    （外部：大模型 API）

        core/contracts.ts  ← 所有人都可以引用它，它谁也不引用
```

- `pipeline` 通过**函数参数**接收 `vault` / `ledger` / `llm`，不用依赖注入框架。
  这样写测试时可以塞一个假的进去，不用起真的文件系统和网络。
- 允许的例外只有一处：`core/contracts.ts` 被所有人引用，但它自己零依赖。

## 一次 `learnmate add` 的数据流

```
1.  命令行         收到一段文本（或一个文件的路径；`.docx` 会先抽成文本）
2.  ingest         规范化（CRLF→LF、去首尾空白）→ 算 sha256 指纹 → 检查长度
3.  ledger         拿指纹查台账：见过就直接提示「已存在」并退出 0，不重复调模型
4.  vault          ★ 把原文写进 vault/.learnmate/raw/<input_id>.txt        ← 第一个写入动作
5.  analyze        取来已有标签词表 → 组装提示词 → 调 llm → 拿到 AnalyzeResult
                   → 用 schema 校验；不合法就重试，最多 2 次
6.  vault          把模型原始产出写进 vault/.learnmate/draft/<input_id>.json
7.  命令行         逐条预览： [y] 写入  [n] 跳过  [a] 全部接受  [q] 退出
                   里面若含「存疑」条目，再逐条问： [k] 保留待确认  [d] 删掉  [e] 我来改写
8.  render         每条 NoteDraft + 元数据 → 一段 Markdown 文本（纯函数）
9.  vault          原子写（先写临时文件，再改名）到 vault/notes/<id>.md
10. ledger         追加一条记录
```

失败怎么分流：

| 情况 | 现场保存到 | 退出码 |
| --- | --- | --- |
| 参数写错 / 配置缺失 | 什么都不写 | 2 |
| 模型返回的内容连重试都校验不过 | 原文和模型原始产出都保留，现场进 `quarantine/` | 3 |
| 网络不通 / 供应商报错 | 原文已落盘，直接退出 | 4 |
| 其它没预料到的异常 | 原文已落盘，直接退出 | 1 |

完整的退出码表见 [03-contracts.md](03-contracts.md) 第 8 节。

## 四条硬约束

1. **`src/core/contracts.ts` 零依赖、零逻辑。** 它只放类型和校验规则，不 import 任何东西。
2. **`src/core/` 里不出现文件读写、网络调用、`Date.now()`、随机数。** 纯计算，同样输入
   永远同样输出。这是这个项目能被稳定测试的唯一原因。
3. **只有 `src/io/vault.ts` 能碰知识库目录。** 别的模块想读写笔记必须经过它，不许自己
   拼路径。这样「文件放在哪、叫什么名字」这件事只有一个地方知道。
4. **原文先落盘，是第一个写入动作，不可跳过、不可撤销。**

## 技术选型

| 用途 | 选了什么 | 为什么 |
| --- | --- | --- |
| 语言 / 运行时 | Node.js 20+ / TypeScript（strict 全开） | 你的知识库就是一堆 `.md`，JS 生态处理文本和文件最省事 |
| 命令行参数 | `commander` | 最主流，帮助信息自动生成 |
| 数据校验 | `zod` | **一份定义同时给出 TypeScript 类型和 JSON Schema**，不会两边写岔 |
| 大模型调用 | 官方 SDK 或 `fetch`，**包在 `io/llm.ts` 的单个方法后面** | 将来换供应商只改一个文件 |
| 存储 | 文件系统 + `ledger.jsonl` | 见下 |
| Markdown 生成 | 手写 TypeScript 模板字符串 | 模板引擎是多余的抽象层 |
| 配置 | `learnmate.config.json` | JSON 解析零依赖 |
| 提示词 | 独立的 `prompts/*.md` 文件 | 它会被反复改十几次，不该埋在代码里 |
| 测试 | Node 自带的 `node:test` | 不引第三方框架 |
| 日志 | 写 stderr + 台账 | v0.1 不需要日志框架 |

### 为什么不用数据库

早先考虑过用 SQLite 做索引，重新权衡后放弃了：

- 台账只需要干两件事——**按指纹查重**和**记录运行审计**，一个 JSONL 文件足够；
- `list` 和 `tags` 需要的信息本来就在每条笔记的 frontmatter 里；
- `notes/` 目录本身就已经是一个完整的索引。

多一个数据库就多一份要同步的状态、多一个会坏的地方。

**什么时候该改主意：** 笔记数超过 5000 条，或者 `list` 耗时超过 1 秒，或者需要跨字段的
复杂查询。到那时候再加，不会晚。

### 明确不引入

Web 框架、数据库/ORM、依赖注入容器、模板引擎、日志框架、消息队列、Docker、向量库、
微服务。

## 未来功能长在哪里

这一层的意义是：**加功能时不要动中间，只在两端长。**

| 版本 | 新功能长在哪 | 不用动什么 |
| --- | --- | --- |
| v0.2 多格式输入 | 新增 `src/io/readers/{pdf,docx,image}.ts`，统一输出纯文本（`docx.ts` 已落地，见 D42） | `core/` 和 `pipeline.ts` 完全不动 |
| v0.3 智能查询 | 新增 `src/retrieval/`，索引放 `vault/.learnmate/index/` | 整理流程完全不动 |
| v0.4 知识网络 | 新增 `core/graph.ts` + frontmatter 里的 `links` 字段 | 靠 `schema_version` 做迁移 |

## 另外两个文件

- `docs/03-contracts.md` —— 数据契约。**改数据结构之前必须先看它。**
- `docs/decisions.md` —— 每个重要决定及其理由，含已经推翻的旧决定和已知技术债。

架构**可以改**，但不能顺手改：任何改动都要在 `decisions.md` 里留一条记录，说明改了什么、
为什么改。这样半年后的你能看懂当时发生了什么。
