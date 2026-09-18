# s02: 事件流 — 循环的一切都是事件

[English](README.md) · [中文](README.zh.md)

[s01](../s01_agent_loop/) → `s02` → [s03](../s03_schema_tools/) → ... → s10
> *"循环的一切都是事件。"* —— 内核只发射；事件的含义由消费者决定。

---

## 问题

s01 的循环是一个黑盒函数：跑完才返回，运行过程什么都看不见。现在加需求：在 TUI 里流式显示文本、写会话日志、断言工具调用顺序的测试、让扩展在每次工具调用前介入……

如果每个需求都用"在这里加个 `console.log`、在那里加个回调参数"来满足，内核就会烂掉——每个功能都在循环体内撕开一道缝。

## 解决方案

```
agent_start
  turn_start
    message_start → message_update … → message_end
    tool_execution_start → tool_execution_end
  （有 toolCall 就继续下一 turn）
agent_end  ← 终止事件
```

循环变成一个**async generator**，产出类型化事件。它不打印、不写盘、不调用任何人。其余一切——渲染、日志、测试、扩展——都作为事件消费者挂在内核**外面**。

这是 pi 最核心的架构决策：`agentLoop()` 返回 `EventStream<AgentEvent, AgentMessage[]>`，整个产品（TUI、会话持久化、扩展系统、RPC 模式）都是这条流的消费者。

## 工作原理

**第 1 步 —— 定义事件词汇表。** 一个可辨识联合覆盖完整生命周期：`agent_start`、`turn_start`、`message_start`、`message_update`（流式增量）、`message_end`、`tool_execution_start/end`、`agent_end`。所有字段都是数据、不是函数——事件因此可以免费序列化成 JSONL。

**第 2 步 —— 内核只 yield，不 print。**

```ts
async function* agentLoop(messages): AsyncGenerator<AgentEvent> {
  yield { type: "agent_start", task: ... };
  while (true) {
    yield { type: "turn_start", turn: ++turn };
    for await (const ev of llmStream()) {
      if (ev.type === "text_delta") yield { type: "message_update", delta: ev.text };
      ...
    }
    if (toolCalls.length === 0) break;
    for (const call of toolCalls) {
      yield { type: "tool_execution_start", ... };
      const output = TOOL_HANDLERS[call.name](call.arguments);
      yield { type: "tool_execution_end", toolCallId: call.id, output };
    }
  }
  yield { type: "agent_end", messageCount: messages.length };
}
```

**第 3 步 —— 消费者从外面挂上来。** 本章的 `main()` 迭代这条流一次，把每个事件转发给两个消费者：终端渲染器（彩色、流式打印）和 JSONL 记录器。测试框架是第三个消费者；pi 的 TUI 是第四个；RPC 模式是第五个。

**第 4 步 —— 流式只是一个事件。** faux provider 现在逐块产出文本，内核把每一块转发为 `message_update`，同时累积完整文本。模型通道与显示通道承载同一事实——一个是数据，一个是视图。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| `EventStream<AgentEvent, AgentMessage[]>` | `pi/packages/agent/src/agent-loop.ts` — `agentLoop()` |
| 完整事件词汇表（`agent_start` … `agent_end`，约 15 种） | `pi/packages/agent/src/types.ts` |
| 流式 `message_update` 事件 | `pi/packages/agent/src/agent-loop.ts` — `streamAssistantResponse()` |
| 事件消费者（TUI、JSONL 会话、RPC） | `pi/packages/coding-agent/src/modes/` |

真实 pi 的流还支持多订阅者并发消费、以及独立于事件的终止返回值——可迁移的是概念，不是 API 表面。

## 试一下

```sh
node s02_event_stream/code.ts
```

观察：assistant 文本**边流边打**（一块一块，而非一次性）；工具执行成对出现 start/end 事件；事件日志落在临时工作区的 `events.jsonl`——打开它读一读原始 JSON 行。

## 接下来

循环会发事件了，但工具分发还是一张 `(args) => string` 的裸表。模型给的参数没人校验；没有 schema；安全工具也没法并行跑。s03 让工具成为 **schema-first 的一等公民**。
