# LearnMate

Personal AI Knowledge Assistant。

把你随手记的学习笔记交给 AI 整理，它会拆成一条条独立的笔记、改写成结构化的
Markdown，存进你自己的知识库。知识库就是一堆普通的 `.md` 文件，用 Obsidian、
VS Code 或任何编辑器都能直接打开看。

> **当前版本 v0.1。**
> 五步闭环：文本输入 → AI 整理 → 生成 Markdown → 存进知识库 → 用户查看。
> 七条命令都能用：`doctor`（查配置 + 知识库体检）、`add`（把笔记交给 AI 整理并写库）、
> `list` / `show` / `tags`（**只读**浏览，不调用模型、不需要 API Key）、
> `reprocess`（用留下来的草稿重新渲染，默认也不调用模型）、
> `rebuild-index`（从 `notes/` 重建台账）。

> **第一次跑之前：`vault/` 还不存在，这是正常的。**
> 知识库由程序自动创建，不需要你手工建目录。先按下面「第一次使用：先配置」配好，
> 再跑一次 `doctor`；它会告诉你还差什么，`add` 第一次写入时会自己把目录结构建出来。
> 在 `add` 之前跑 `list` / `show` / `tags`，看到的是「空知识库」而不是报错。

## 环境要求

- Node.js **20 或更高**（本机开发用的是 v22）

## 怎么跑

```bash
npm install                  # 安装依赖，只需要跑一次
npm run build                # TypeScript 编译到 dist/
node dist/main.js --help     # 应该看到 learnmate 的帮助信息
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译到 `dist/` |
| `npm test` | 跑测试 |
| `npm run typecheck` | 类型检查（`src/` 和 `tests/` 都查，不产出文件） |
| `npm run dev -- <参数>` | 直接跑 `src/main.ts`，不用先编译（走 tsx） |
| `npm start -- <参数>` | 跑编译后的 `dist/main.js` |

> `npm test` 会先把 `src/` 和 `tests/` 一起编译到 `dist-test/`（已被 gitignore），
> 再用 Node 自带的测试器跑编译产物。
>
> 之所以不用 `tsx` 直接跑 `.ts` 测试，是因为 tsx 依赖 esbuild 起一个后台子进程——
> 在禁止子进程的受限环境里会直接 `spawn EPERM` 失败。多编译一遍花一两秒，
> 换来的是在哪都能跑，而且跑的就是真正会被执行的那份代码。

## 第一次使用：先配置

```powershell
copy learnmate.config.example.json learnmate.config.json
```

然后打开 `learnmate.config.json`，把 `model` 填成你要用的模型标识（例如 `deepseek-chat`），
再把 API Key 放进环境变量：

**cmd.exe**（等号两边不能有空格，值也不要加引号）：

```bat
set LEARNMATE_API_KEY=你的密钥        :: 只在当前窗口有效
setx LEARNMATE_API_KEY 你的密钥       :: 永久生效，需要重开一个窗口
```

**PowerShell**：

```powershell
$env:LEARNMATE_API_KEY = "你的密钥"
setx LEARNMATE_API_KEY "你的密钥"
```

六个配置项分别是干什么的：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `vaultPath` | `./vault` | 知识库位置，相对**当前工作目录** |
| `model` | 无，**必填** | 模型标识，会写进每条笔记的 frontmatter |
| `promptVersion` | `analyze.v2` | 对应 `prompts/<版本>.md` |
| `maxInputChars` | `20000` | 单次输入的长度上限，超过直接报错、不截断 |
| `requestTimeoutMs` | `60000` | 单次模型请求超时（毫秒） |
| `apiKeyEnv` | `LEARNMATE_API_KEY` | 存放密钥的**环境变量名** |

配置完检查一下：

```bash
node dist/main.js doctor
```

它会打印读到的每一项配置，并告诉你还差什么。**退出码 0 = 就绪，2 = 还差东西。**
缺 API Key、缺提示词文件都算「还差东西」——`doctor` 会告诉你具体缺哪一样、怎么补。

## 日常使用

### 1. 把笔记交给 AI：`add`

```bash
node dist/main.js add ..\_tmp\示例输入.txt      # 从一个文件读
type 我的笔记.txt | node dist/main.js add -   # 从管道读（中文乱码先 chcp 65001）
```

它会调用模型，把内容拆成一条条独立笔记，**先给你看预览**再问要不要写入：

- `y` 写入 / `n` 跳过这一条 / `a` 剩下的全写 / `q` 整批取消（一个字节都不写）
- 某条笔记里有模型拿不准的地方时，它会单独问你，按 `e` 可以当场改成你要的表述

```bash
node dist/main.js add ..\_tmp\示例输入.txt --dry-run   # 只预览，一个字都不写
node dist/main.js add ..\_tmp\示例输入.txt --yes       # 不询问，直接写
node dist/main.js add ..\_tmp\示例输入.txt --force     # 同一份内容已经处理过时也照样再处理
```

### 2. 看知识库里有什么：`list` / `show`

```bash
node dist/main.js list                     # 一行一篇，最新的在最上面
node dist/main.js list --tag 示例标签       # 只看带某个标签的（大小写不敏感）
node dist/main.js list --status inbox      # 只看还没整理的
node dist/main.js show 先做                # 打出一篇的正文
node dist/main.js show 01M3NRXYPSEJ8PY09XTSZ5S4YA   # 用完整 id 精确打开
node dist/main.js show 先做 --raw          # 连 frontmatter 一起打（复制/备份用）
```

只读，**不调用模型、不需要 API Key、不改任何文件**。关键词命中多篇时它会列出候选让你挑，
**绝不瞎猜**（`show` 找不到东西时退出码是 2）。

> 文件名里那个 8 位后缀**不是**句柄：它是笔记 id 的前 8 位，而 id 开头是毫秒时间戳，
> 同一次 `add` 产出的十几条笔记后缀完全一样（真实数据里 13 篇共用 `01m3nr4j`）。
> 要精确指定一篇，请用完整 26 位 id——`list` 打出来的第一列就是。

### 3. 看用过哪些标签：`tags`

```bash
node dist/main.js tags             # 一行一个
node dist/main.js tags --counts    # 每行追加「这个标签被几篇笔记用过」
```

顺序和 `add` 注入给模型的词表**是同一份**——所以「你看到的顺序就是模型看到的顺序」。
这份词表直接从 `notes/` 里的 frontmatter 收集，不依赖台账。

### 4. 整理得不满意，重做：`reprocess`

```bash
node dist/main.js reprocess                                  # 列出能重处理的输入
node dist/main.js reprocess --input <26位id> --dry-run       # 先看会动哪几篇
node dist/main.js reprocess --input <26位id>                 # 真改（逐篇问你 y/n/a/q）
node dist/main.js reprocess --note <26位id>                  # 只重做一篇
node dist/main.js reprocess --input <26位id> --reanalyze     # 让模型重新分析一遍
```

**默认只重新排版、不调用模型、不花钱**——它用的是当初留在 `draft/` 里的模型返回，
加上你当时对存疑项做的裁定（存在 `resolutions/` 里）。只有加了 `--reanalyze` 才会真的
重新调用模型：那会生成新的一批笔记，**旧笔记先挪进 `vault\.learnmate\trash\`**，不会直接删。

## 台账坏了怎么办：`rebuild-index`

`vault/.learnmate/ledger.jsonl` 是知识库里唯一记得「这条笔记是哪一次输入产生的」的东西——
查重、溯源都靠它。但它被设计成**派生数据**：只要 `notes/` 还在，删掉它就能长回来。

```bash
node dist/main.js rebuild-index --dry-run   # 先看看会怎么重建，不写文件
node dist/main.js rebuild-index             # 真的重建
```

它会告诉你：沿用了多少条（这些保住了原来的用量和耗时）、新造了多少条、剔除了多少条
（笔记文件已经不在了）、以及**台账里有多少行读不懂**（断电留下的半行，重建会把它们抹掉——
所以这个数字一定会打出来，不会静默消失）。

> 重建救不回来的是 `tokens_in` / `tokens_out` / `latency_ms` 和存疑统计——`notes/` 里从来没有这些字段，
> 补出来的 0 意思是「不知道」。详见 `docs/03-contracts.md` 第 9.2 节。

> **铁律：API Key 只放环境变量，永远不要写进 `learnmate.config.json`。**
> 配置文件里只写「变量叫什么名字」，不写密钥本身。
> `learnmate.config.json` 已被 `.gitignore` 忽略，但就算这样也别往里写密钥——
> 截图、贴日志、找人帮忙排查的时候，都可能顺手把它带出去。

## 知识库出事了怎么办

`vault/` 是一个普通目录，出问题基本都能靠文件系统手段救回来：

| 症状 | 怎么办 |
| --- | --- |
| 台账坏了 / 被删了 | 跑 `rebuild-index` 重建——`notes/` 是真相，台账是派生数据 |
| 笔记写坏了 | 找 `.learnmate/draft/<input_id>.json` 里的原始草稿，跑 `reprocess --input <26位id>` 重渲染 |
| 误删了笔记 | 找 `.learnmate/trash/`（`reprocess --reanalyze` 会把旧笔记挪进去，不直接删） |
| 误删了原文 | `.learnmate/raw/<input_id>.txt` 是唯一的一份原文，删了就重新整理不了了，别手工删 |
| 断电 / 写到一半 | 半行台账会被 `rebuild-index` 抹掉并报出条数；写到一半的笔记文件会被 `doctor` 挑出来 |
| 想知道现在什么状态 | 跑 `doctor`，它会做一遍知识库体检并列出孤儿文件 |

## 目录结构

```
LearnMate/
├─ src/
│  ├─ main.ts          命令行入口：解析参数、调用下层、决定退出码
│  ├─ core/            纯逻辑，禁止文件 / 网络 / 时间（见下方「一条重要的规矩」）
│  ├─ io/              所有外部世界的边界：知识库文件、台账、大模型调用
│  └─ commands/        每条子命令一个文件
├─ docs/               契约文档（数据结构、命令行为）
├─ prompts/            AI 提示词，会被反复迭代，单独放
├─ tests/              测试
├─ vault/              你的知识库（被 .gitignore 忽略，不会进 Git）
```

知识库里面长这样（目录由程序自动创建，你不用手工建）：

```
vault/
├─ notes/                         ← 只有这里是你平时要看的
│  └─ 示例笔记-先做-A-再做-B-01j8zq7v.md
└─ .learnmate/                    ← 点开头，Obsidian 默认忽略
   ├─ raw/<输入id>.txt            ← 你贴进来的原文，改都不改
   ├─ draft/<输入id>.json         ← AI 这次返回的全部草稿
   ├─ resolutions/<输入id>.json   ← 你对存疑项做的裁定（改 / 删）
   ├─ ledger.jsonl                ← 台账：处理过什么、产出过什么
   ├─ quarantine/                 ← 校验失败的现场
   └─ trash/                      ← 被重做掉的旧笔记（`reprocess --reanalyze` 会往这儿放）
```

文件名里的 `-01j8zq7v` 后缀是笔记 id 的前 8 位。**但真正保证「标题一样的两条笔记不会互相
覆盖」的不是这个后缀**——id 的前 8 位只精确到约 1 秒，同一批里生成的两条笔记会共用同一个
后缀。真正的防线是写文件之前先把这一批的目标文件名全算出来，发现重名就**整批不写**、
报错让你切开输入。

## 再往下读

改代码之前先看这两份：

| 文件 | 讲什么 |
| --- | --- |
| [docs/03-contracts.md](docs/03-contracts.md) | **数据契约**（主参考）：一条笔记长什么样、AI 被允许产出什么、写文件的顺序、每条命令的行为与退出码 |
| [docs/02-architecture.md](docs/02-architecture.md) | 模块怎么划分、谁依赖谁 |
| [docs/01-project-brief.md](docs/01-project-brief.md) | 要解决什么问题、v0.1 做什么和不做什么 |

改任何跟数据结构沾边的代码之前，先看 `03-contracts.md`。

## 一条重要的规矩

**`src/core/` 里不允许出现文件读写、网络调用、`Date.now()`、随机数。**

这一层是纯计算：同样的输入，永远得到一模一样的输出。一旦它开始碰时间、碰磁盘，
就再也没法稳定地测试了。所有 IO 只允许出现在 `src/io/`。

配套的第二条规矩：**只有 `src/io/vault.ts` 能碰知识库目录**。别的模块想读写笔记，
必须通过它，不许自己拼路径。
