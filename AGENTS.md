# AGENTS.md

TypeScript / Node.js >= 20 / ESM。运行时依赖只有 `commander`。

## 动手之前

**改任何跟数据结构沾边的代码之前，先读 [docs/03-contracts.md](docs/03-contracts.md)。**
它是数据权威，已冻结（`schema_version = 1`）。字段名、目录位置、命名规则、块类型、写入顺序的
任何改动，**必须先改那份文档**，并在 [docs/decisions.md](docs/decisions.md) 追加一条决策记录。

模块划分与依赖方向见 [docs/02-architecture.md](docs/02-architecture.md)。

## 验证

```bash
npm run typecheck   # src/ 和 tests/ 一起查
npm test            # 461 个用例，必须全绿
```

**两个都要过。** 测试跑的是编译到 `dist-test/` 的产物，所以改了 `src/` 忘了编译会被发现。
PowerShell 下 `npm` 往 stderr 写一行 `npm notice`，无害。

## 四条硬约束

破坏任何一条都算架构倒退。

1. **`src/core/` 里不出现文件读写、网络调用、`Date.now()`、随机数。**
   所有 IO 只允许在 `src/io/`。需要 id 或时间时，**由调用方生成好再作为参数传进去**。
2. **`src/core/contracts.ts` 零依赖、零逻辑。** 只放类型和校验规则，不 import 任何东西。
3. **只有 `src/io/vault.ts` 能碰知识库目录。** 别的模块不许自己拼路径。
4. **原文先落盘，是第一个写入动作，不可跳过、不可撤销。**
   唯一例外是 `add --dry-run`：全程零写入，连 `raw/` 都不写。

依赖方向只能从上往下，箭头反过来就是架构被破坏：

```
main.ts → commands/*.ts → pipeline.ts → { ingest, analyze, render, vault, ledger }
                                              ↓
                                      util / io/llm（外部：大模型 API）

core/contracts.ts  ← 所有人都可以引用它，它谁也不引用
```

## 不能顺手改的东西

| 东西 | 规矩 |
| --- | --- |
| **已发布的提示词文件** | `prompts/analyze.v1.md` 与 `analyze.v2.md` **永不删除、永不改写**——老笔记的 frontmatter 指向具体文件内容，删了就还原不出当年的笔记。要改就新建版本。 |
| **提示词里的占位符** | 只有 `{{TAG_VOCABULARY}}`，纯字符串替换；出现别的 `{{...}}` 一律报错。**用户原文作为用户消息发送，绝不进提示词文件。** |
| **退出码** | `0` 成功/用户取消、`1` 未预料异常、`2` 参数或配置错误、`3` 校验失败或撞名、`4` 网络/供应商错误。改一条就是破坏接口。 |
| **frontmatter 字段** | 14 个，顺序有约定（`input_id` 紧跟 `id`）。增删 = 改契约。 |
| **`source_ref`** | 只存文件名，**绝不存完整路径**。 |
| **`tags`** | 只装知识维度的词，**不要把批次信息写进去**。 |
| **`draft/`** | write-once。存疑项裁定写到 `resolutions/`，`draft/` 一个字节都不改。 |
| **撞名守卫** | 写笔记前先算出全批目标文件名；批内撞名或磁盘已存在 → `UnsafeWriteError`（退出码 3），**整批一条都不写**。比较忽略大小写。 |
| **`rebuild-index`** | 唯一会重写 `ledger.jsonl` 的代码路径。`add` 只追加。 |

## 写测试

- 用 Node 自带的 `node:test`，**不引第三方测试框架**。
- 改测试夹具前，**先确认断言依赖的是字符串的什么性质**。例如撞名守卫的用例依赖「两个标题不相等但 slug 相同」，把夹具改成一样会让它抛 `ValidationError` 而不是 `UnsafeWriteError`。
- 源码的用户可见消息和测试断言里，**不要塞内部任务编号**（`TD8`、`D38` 这类）。

## 脱敏

仓库已完整脱敏、准备公开。**新写的代码、测试、文档里不要引入真实个人信息、真实笔记标题、真实绝对路径或真实软件名。**

夹具用中性词：`乙插件`、`甲脚本`、`乙脚本`、`素材加边缘光`、`素材加投影`、`位移`、`嵌套工程`、`新建工程`、`工具基础设置`、`示例输入`、`<仓库根目录>`。
可以用泛指软件名和通用术语（`AE`、`发光半径`、`1920 × 1080`、`Ctrl+D`）。不要用真实用户名、QQ/邮箱、`C:\Users\...` 路径、真实课程文件名。

**提交前自查**：不应出现 `vault/`、`learnmate.config.json`、`.env` 或任何 API Key。三者都已被 `.gitignore` 忽略——**永远不要提交**。

## 一条提醒

`vault/` 里是**用户的真实笔记**，属于私人数据。除非用户明确要求，**不要读取、打印或复制到别处**。

---

每条约束的理由见 [docs/decisions.md](docs/decisions.md)。
