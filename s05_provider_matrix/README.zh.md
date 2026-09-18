# s05: Provider 矩阵 — API 与 Provider 正交

[English](README.md) · [中文](README.zh.md)

[s04](../s04_tool_results/) → `s05` → [s06](../s06_extensions/) → ... → s10
> *"API 与 Provider 正交。"* —— 10 种线协议 × 40+ 家 Provider，不写 400 个适配器。

---

## 问题

你想支持 Anthropic、OpenAI、DeepSeek、Google、Bedrock、Groq、OpenRouter、Kimi、Qwen，还有三十多家。天真的架构是每家厂商写一个适配器：`DeepSeekClient`、`GroqClient`、`KimiClient`……各自漂移、各自重复着同一段工具调用翻译（只是口音不同）。N 家厂商 × M 种协议 = N×M 个适配器，永无止境。

## 解决方案

pi 沿着问题的天然轴线切开（`pi/packages/ai/src/types.ts`）：

```
Api      = 线协议               "anthropic-messages" | "openai-completions" | ...（共 10 种）
Provider = 厂商                 baseUrl + 鉴权 + 模型目录，选定一种 Api
Compat   = 类型化能力开关        吸收"同协议不同厂商"的方言漂移
```

关键洞察：大多数厂商并不是新协议——它们是**同一协议的方言**。DeepSeek、Groq 和上百个 OpenAI 兼容端点说的都是 "openai-completions"，只在细小的、布尔值级别的地方不同：这家要不要在工具结果消息里带 `name`？支不支持并行工具调用？这些差异变成 **compat 开关**，在共享适配器内部处理——而不是新适配器。

结果：真实 pi 里一个 `openai-completions` 实现服务约 25 家厂商。

## 工作原理

**第 1 步 —— 内核只说统一模型。** 四种角色的 `Message` + 类型化内容块。适配器在外出时做"统一 → 线协议"翻译、在返回时做"线协议 → 统一"。s01–s04 的 agent 循环永远不知道回答来自哪家。

**第 2 步 —— 协议差异住在适配器里。** Anthropic：system 是顶层参数、工具结果作为 `tool_result` 块挂在 user 回合。OpenAI：system 是第一条聊天消息、工具结果用 `role: "tool"`。两个函数，这就是全部协议层。

**第 3 步 —— 方言差异住在 compat 开关里。**

```ts
const base = { role: "tool", tool_call_id: m.toolCallId, content: m.content };
if (compat.requiresToolResultName) base.name = m.toolCallId; // 旧方言的怪癖
```

一行、类型化、有文档——而不是分叉出一个新适配器。

**第 4 步 —— 模型目录是生成的。** Provider 声明模型；脚本渲染出 `models.generated.ts`（上下文窗口、价格分层、推理能力）。禁止手改。`pi update --models` 刷新。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| `Api` / `Provider` / `Compat` 类型 | `pi/packages/ai/src/types.ts` |
| 10 种线协议实现 | `pi/packages/ai/src/api/*.ts`（全部懒加载） |
| 40+ 家 Provider 注册 | `pi/packages/ai/src/providers/` + `providers/all.ts` |
| OpenAI compat 矩阵（约 25 个布尔开关） | `ai/src/types.ts` 中的 `OpenAICompletionsCompat` |
| 生成式模型目录 | `pi/packages/ai/src/models.generated.ts` |
| 测试用 faux provider | `pi/packages/ai/src/providers/faux.ts` |

## 试一下

```sh
node s05_provider_matrix/code.ts
```

同一段对话被序列化三次：Anthropic 线协议、标准 OpenAI 兼容、旧式 OpenAI 兼容。肉眼 diff 三个 JSON——工具结果消息恰好只差那个 compat 开关，其余完全一致。再看目录查询：`deepseek-chat → 厂商、上下文窗口、价格`。

## 接下来

内核已经接近完整——但到目前为止，每个能力都是"造进去"的。pi 的大师手笔恰恰是它**拒绝**造进去的东西：权限、子代理、MCP。s06 从侧面打开内核：扩展系统。
