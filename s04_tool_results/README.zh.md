# s04: 工具结果双通道 — `content` 给模型，`details` 给界面

[English](README.md) · [中文](README.zh.md)

[s03](../s03_schema_tools/) → `s04` → [s05](../s05_provider_matrix/) → ... → s10
> *"`content` 给模型，`details` 给界面。"* —— 一个结果，两条通道；外加一道拯救截断消息的防御。

---

## 问题

工具返回一个字符串，所有人吃同一个字符串：

- **模型**要的是要点（"编辑了 config.txt，+1 行"）——每个字节都要永久消耗 token。
- **界面**要的是丰富——完整彩色 diff、退出码、变更路径。
- 谁都不想要对方的东西：diff 撑爆上下文；干巴巴的摘要无聊死用户。

还有个更阴险的问题：模型消息撞上输出 token 上限时，可能停在**工具调用写到一半**——参数 JSON 只写了一半。执行它等于执行损坏的数据。

## 解决方案

```ts
type AgentToolResult<TDetails> = {
  content: TextBlock[];   // → 进入 messages[]，按 token 计价
  details?: TDetails;     // → 只给渲染器，免费
  terminate?: boolean;    // → 这个结果可以终结整个 agent
};
```

外加一条内核规则：**`stopReason === "length"` 且有未执行的工具调用 ⇒ 绝不执行。** 用一条合成的 `toolResult` 标记失败、说明原因，让模型重发更小的批次。

## 工作原理

**第 1 步 —— 通道分离。** `edit` 工具返回 `content: "Edited config.txt (+1 lines)."` 和 `details: { path, linesChanged, diff }`。渲染器打印完整绿色 diff；模型只看到一句话。上下文保持精瘦，界面保持丰富。

**第 2 步 —— 用 `onUpdate` 流式输出。** 长时工具拿到 `onUpdate(partial)` 回调，每次更新刷新 UI；模型只收到**最终** content。真实 pi 中这是 `tool_execution_update` 事件，由 TUI 的进度组件消费。

**第 3 步 —— `terminate`。** `task_complete` 工具返回 `terminate: true`，内核在这个结果后停止循环——循环里没有特判，**工具结果本身携带意图**。（真实 pi：批次内全部调用 terminate 时，agent 结束。）

**第 4 步 —— 截断防御。**

```ts
if (response.stopReason === "length" && toolCalls.length > 0) {
  failToolCallsFromTruncatedMessage(toolCalls, messages); // 合成错误结果
  continue;  // 模型读到失败原因，重发更小的批次
}
```

pi 的 `agent-loop.ts` 第 434 行做的正是这件事。流式 JSON 抢救解析也许"看起来能行"——pi 选择不赌。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| 含 `content` / `details` / `terminate` 的 `AgentToolResult` | `pi/packages/agent/src/types.ts` |
| 流式部分结果 | 工具 `execute` 的 `onUpdate`、`tool_execution_update` 事件 |
| 截断防御 | `pi/packages/agent/src/agent-loop.ts` — `failToolCallsFromTruncatedMessage()` |
| UI 通道渲染器 | `pi/packages/coding-agent/src/core/tools/renderers/*.ts` |
| 输出截断（头尾预算） | `pi/packages/coding-agent/src/core/tools/truncate.ts` |

## 试一下

```sh
node s04_tool_results/code.ts
```

跟上四个回合：① `edit` —— 彩色 diff 打印出来的同时，**模型历史里只记了一句话**。② 脚本化的模型撞上 `stopReason: length`，带着一条只写了一半的 `bash` 调用——红色警告触发、调用被标记失败、什么都没执行。③ 模型重发精简批次；`bash` 流式打印进度。④ `task_complete` 返回 `terminate`，循环干净收尾。

## 接下来

内核现在只接了一个写死的 faux provider。真实产品需要几十家 Provider、十种线协议——但不写 N×M 个适配器。s05 构建 API × Provider 正交设计，看 pi 如何用 10 个协议实现服务 40+ 家 Provider。
