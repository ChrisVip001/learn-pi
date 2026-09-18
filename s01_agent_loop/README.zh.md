# s01: Agent Loop — 内核就是一个循环

[English](README.md) · [中文](README.zh.md)

`s01` → [s02](../s02_event_stream/) → s03 → ... → s10
> *"内核就是一个循环。"* —— 回应里没有工具调用？停。有？执行、回填、继续。

---

## 问题

模型能*写出*一条 bash 命令，但它不能*运行*这条命令。没有 harness，你自己就是 harness：把命令贴进终端，把输出贴回对话框，等下一条命令，再重复。

你手工做的每一个来回，都是循环的一次迭代。把这个循环自动化，就是 agent 内核的全部工作内容。

## 解决方案

```
   用户 prompt ──► messages[] ──► LLM ──► 回应内容块
                                        │
                              包含 toolCall 块？
                              /               \
                            是                 否
                             │                 │
                       执行 handler           停止
                       追加 toolResult
                       回到开头 ────────► messages[]
```

与"通用 agent loop"相比，pi 风格的循环有两个独特设计：

1. **统一消息模型。** 只有四种角色：`system`、`user`、`assistant`、`toolResult`。assistant 消息是类型化内容块（`text` | `toolCall`）组成的列表。这是 pi-ai 消息体系的迷你版——一套模型，适配所有 Provider。
2. **脚本化 FauxProvider。** 默认的 LLM 后端完全离线、输出确定。pi 正是内置了同样的东西（`faux.ts`），让测试套件零成本、不抖动。本课程全程沿用：每章 `node code.ts` 即可运行，无需任何 key。

## 工作原理

**第 1 步 —— 工具是"两样东西"。** 一个 `ToolSchema`（给模型看的）+ 一个注册在分发表里的 handler（给内核执行的）。模型永远看不到 handler 代码；内核永远不解析自然语言。

**第 2 步 —— 循环检查的是内容块，不是标志位。** 每次拿到 LLM 回应，过滤出 `toolCall` 块。数量为零 → 模型决定停止 → 返回。这一条规则就是全部控制流。

**第 3 步 —— 结果是"带地址"的消息。** 每条 `toolResult` 通过 `toolCallId` 回指它应答的那次调用，模型对每个调用都能得到明确答案。

```ts
async function agentLoop(messages, llm) {
  while (true) {
    const response = await llm(messages, TOOLS);
    messages.push({ role: "assistant", content: response.content });

    const toolCalls = response.content.filter((b) => b.type === "toolCall");
    if (toolCalls.length === 0) return;          // 模型决定停止

    for (const call of toolCalls) {
      const output = TOOL_HANDLERS[call.name](call.arguments);
      messages.push({ role: "toolResult", toolCallId: call.id, content: output });
    }
  }
}
```

**第 4 步 —— 工作区是一次性的。** 演示在临时目录里创建工作区。内核绝不把模型命令跑在你的真实项目里——**默认安全，而非弹窗审批**（这个主题会在 s07 回归）。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| 双层 while 循环、follow-up 队列 | `pi/packages/agent/src/agent-loop.ts` — `runLoop()` |
| 统一消息模型 | `pi/packages/ai/src/types.ts` |
| FauxProvider | `pi/packages/ai/src/providers/faux.ts` |
| 产品层循环接线 | `pi/packages/coding-agent/src/core/agent-session.ts` |

真实循环还增加了 steering（流式中插话）、重试、中止处理——但它核心处那个"有没有 toolCall"的判断，与上面的一字不差。

## 试一下

```sh
node s01_agent_loop/code.ts
```

观察：第 1 轮调用 `ls`，第 2 轮写入 `summary.txt`（两个工具轮都以黄色打印），第 3 轮不含 `toolCall` → 循环退出。faux 脚本是固定的，每次运行输出完全一致。

接入真实模型（任意 OpenAI 兼容端点）：

```sh
PI_API_KEY=sk-... PI_BASE_URL=https://api.deepseek.com PI_MODEL=deepseek-chat \
  node s01_agent_loop/code.ts "rename summary.txt to report.txt"
```

## 接下来

现在循环是一个"跑完才返回"的函数——运行中你无法渲染进度、记录事件、挂接 UI。pi 的答案是：**循环不是函数，是事件流。** s02 把内核翻个面。
