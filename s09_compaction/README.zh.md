# s09: 上下文压缩 — 永远别把调用和结果切开

[English](README.md) · [中文](README.zh.md)

[s08](../s08_session_tree/) → `s09` → [s10](../s10_mini_pi/) → s10
> *"永远别把调用和结果切开。"* —— 从最新条目倒序回走、守住预算、找到合法边界、摘要其余部分。

---

## 问题

长任务会撑爆任何上下文窗口。天真的修法——截掉最旧的消息——会悄悄损坏对话：切错位置，assistant 的 `toolCall` 就失去了对应的 `toolResult`（或结果变成孤儿）。多数提供商**直接拒绝请求**；不拒绝的也会让模型困惑。agent 恰恰在最有效的时刻——深入长任务时——死掉。

## 解决方案

pi 的压缩是四步算法加一条铁律：

```
触发：     contextTokens > contextWindow - reserveTokens
第 1 步：  从最新条目倒序累积，直到覆盖 keepRecentTokens
第 2 步：  把切点调整到合法边界          <- 铁律在这里
第 3 步：  摘要切点之前的所有内容
第 4 步：  请求 = system + 摘要 + 保留条目   （日志保持追加式）
```

铁律：**`toolResult` 永远不能与请求它的 assistant 消息分开。** 如果倒序回走正好落在一对中间，边界后移，直到调用与结果团聚。

## 工作原理

**第 1 步 —— 触发纪律。** 不是定时器、不是"每 N 轮"：检查运行在每个工具批次后、每个用户 prompt 前、每次 agent 运行后——正是上下文可能增长的瞬间。`/compact [instructions]` 可用自定义指引手动强制。

**第 2 步 —— 倒序回走。** token 估算（字符数/4）从最新条目累积到覆盖 `keepRecentTokens`。倒着走（而非正着走）保证**最新**的工作永远是受保护区。

**第 3 步 —— 合法边界调整。**

```ts
while (entries[cut].type === "toolResult") {
  cut--;  // 把配对的 assistant 调用拉回保留区
}
```

一个循环；请求里永远不会出现孤儿结果。

**第 4 步 —— 投影与日志分离。** 压缩缩小的是**请求投影**，绝不是**会话日志**。s08 的 JSONL 树保持追加式、完整——你随时可以导出全部转录，回放保持忠实。（真实 pi 会持久化一条带 `firstKeptEntryId` 的 `CompactionEntry`——连压缩本身都是日志里的一条记录。）

**分裂回合。** 一个超大回合（单个工具结果超过整个预算）会得到**两份摘要**：一份给之前的历史、一份给该回合自身的前缀——然后回合在预算内继续。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| 压缩算法（约 30KB） | `pi/packages/coding-agent/src/core/compaction/compaction.ts` |
| 触发点（`_checkCompaction`） | `agent-session.ts` —— 批次后、prompt 前、运行后 |
| 合法切点、分裂回合处理 | `compaction.ts` |
| 带 `firstKeptEntryId` 的 `CompactionEntry` | 会话格式，`docs/session-format.md` |
| 切树时的分支摘要 | `compaction/branch-summarization.ts` |
| 扩展接管（`session_before_compact`） | `extensions/types.ts` |
| agent-core 侧的独立实现 | `pi/packages/agent/src/harness/compaction/compaction.ts` |

## 试一下

```sh
node s09_compaction/code.ts
```

这个会话（8 个条目、超大工具输出）超出了刻意调小的 900 token 窗口。观察：倒序回走正好落在 `c3` 的调用与结果之间——边界**后退一步**让这对团聚；较旧区域变成紫色摘要；请求上下文从约 1100 token 降到约 400，而日志依然是 8 个条目。

## 接下来

九个机制全部建成。s10 把它们组装成 **mini-pi**：事件驱动循环 + schema 工具 + 扩展 + 会话树 + 压缩，一个运行时、约 300 行——并证明内核依然柔韧不折。
