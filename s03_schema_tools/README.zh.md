# s03: Schema-First 工具 — 工具 = Schema + Handler

[English](README.md) · [中文](README.zh.md)

[s02](../s02_event_stream/) → `s03` → [s04](../s04_tool_results/) → ... → s10
> *"工具 = schema + handler。"* —— schema 面向模型，handler 面向内核，校验夹在中间。

---

## 问题

s02 的工具分发是一张 `(args) => string` 的裸表。随之而来三个问题：

1. **没有校验。** 模型漏掉 `path`、或把 `{ command: "ls" }` 写成 `{ cmd: "ls" }`，handler 直接崩溃，循环死于一个笔误。
2. **没有并发语义。** 并发读两个文件安全又快；并发跑两条 shell 命令可能互相破坏。分发表无法区分它们。
3. **没有变更通知。** 工具中途出现（由扩展安装）时模型毫不知情——要么继续用旧工具集，要么幻觉出新工具。

## 解决方案

pi 的 `AgentTool` 用"结构"而非"策略"一并回答：

```ts
interface AgentTool<S extends Schema> {
  name: string;
  description: string;
  parameters: S;                                  // schema-first
  executionMode: "sequential" | "parallel";       // 并发性是工具自身的事实
  prepareArguments?: (args) => args;              // 兼容垫片，纠正不守规矩的模型
  execute: (args: Infer<S>) => string;            // 类型由 schema 推导
}
```

外加一条影响深远的内核规则：**工具集变化时，把变化作为一条消息声明进会话历史。** 模型被告知；回放保持忠实；工具可用性成为对话的一部分。

## 工作原理

**第 1 步 —— 40 行的 TypeBox。** `T.object({ path: T.string() })` 构建可组合 schema；`type Infer<S>` 从 schema **推导出 TypeScript 类型**，`execute` 的参数因此是静态类型化的。这正是 pi 选 TypeBox 的原因：schema 即类型，不需要重复声明。

**第 2 步 —— 先校验后执行。** `validate(schema, args)` 沿 schema 走一遍。非法参数变成一条普通的错误 `toolResult`——模型看到自己的错误、下一轮自我修正。**没有崩溃，回合继续。**

**第 3 步 —— 兼容垫片。** `prepareArguments` 修复方言漂移（模型把 `command` 写成 `cmd`）。pi 给每个工具这个钩子，而不是在内核里特判某家模型。

**第 4 步 —— 按模式拆分批次。** 模型下发的一批调用中，parallel 工具进 `Promise.all`；sequential 工具随后逐个执行。注意这里**没有**什么：全局并发策略。每个工具声明自己的模式。

**第 5 步 —— `declareToolChanges`。** 注册表新增（或移除）工具时，内核追加一条系统消息：`[tool changes] Tools added: grep`。真实 pi 中这条消息携带 `toolsAdded`/`toolsRemoved` 并进入持久化会话——回放会话，就回放了工具集的演化史。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| `AgentTool` 接口（`executionMode`、`prepareArguments`） | `pi/packages/agent/src/types.ts` |
| handler 前的 schema 校验 | `pi/packages/agent/src/agent-loop.ts` — `prepareToolCall()` |
| 顺序/并行批次、结果保序 | `pi/packages/agent/src/agent-loop.ts` — `executeToolCalls()` |
| 工具变更写入历史 | `pi/packages/agent/src/agent-loop.ts` — `declareToolChanges()` |
| 处处 TypeBox | `pi/packages/coding-agent/src/core/tools/` 下每个工具 |
| 内置工具（只有 8 个！） | read、bash、edit、write、grep、find、ls、powershell |

## 试一下

```sh
node s03_schema_tools/code.ts
```

观察三个瞬间：第 1 轮批次混着两个 `read`（并行）、一个 `bash`（顺序）、一个**非法的 `grep` 调用**——看它以普通错误结果失败、循环照常继续。第 2 轮前，`grep` 被安装，一条紫色 `[tool changes]` 进入历史。垫片默默把 `{ cmd: "ls" }` 修成 `{ command: "ls" }`。

## 接下来

工具只返回一个字符串。但 pi 把工具"告诉模型的"与"展示给用户的"拆成两条通道——不同通道、不同形态。s04 构建双通道结果、流式部分结果，以及针对模型消息被截断的防御。
