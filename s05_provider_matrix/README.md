# s05: Provider Matrix — API and Provider Are Orthogonal

[English](README.md) · [中文](README.zh.md)

[s04](../s04_tool_results/) → `s05` → [s06](../s06_extensions/) → ... → s10
> *"API and Provider are orthogonal."* — 10 wire protocols × 40+ providers, without writing 400 adapters.

---

## The Problem

You want to support Anthropic, OpenAI, DeepSeek, Google, Bedrock, Groq, OpenRouter, Kimi, Qwen, and thirty more. The naive architecture writes one adapter per vendor: `DeepSeekClient`, `GroqClient`, `KimiClient`… each drifting, each duplicating the same tool-call translation with a different accent. N vendors × M protocols = N×M adapters, forever.

## The Solution

pi splits the problem along its natural axes (`pi/packages/ai/src/types.ts`):

```
Api      = the wire protocol        "anthropic-messages" | "openai-completions" | ... (10 total)
Provider = the vendor               baseUrl + auth + model catalog, PICKS an Api
Compat   = typed capability flags   absorbs dialect drift between vendors on the SAME protocol
```

The insight: most vendors are not new protocols — they are **dialects of the same protocol**. DeepSeek, Groq, and a hundred OpenAI-compatible endpoints all speak "openai-completions"; they differ in small, boolean ways: does this one require `name` on tool-result messages? Does it support parallel tool calls? Those differences become **compat flags**, applied inside the shared adapter — not new adapters.

Result: one `openai-completions` implementation serves ~25 vendors in real pi.

## How It Works

**Step 1 — the kernel speaks only the unified model.** `Message` with four roles and typed content blocks. Adapters translate `unified → wire` on the way out and `wire → unified` on the way back. The agent loop from s01–s04 never learns which vendor answered.

**Step 2 — protocol differences live in adapters.** Anthropic: system is a top-level param, tool results ride as `tool_result` blocks in user turns. OpenAI: system is the first chat message, tool results use `role: "tool"`. Two functions, that's the whole protocol layer.

**Step 3 — dialect differences live in compat flags.**

```ts
const base = { role: "tool", tool_call_id: m.toolCallId, content: m.content };
if (compat.requiresToolResultName) base.name = m.toolCallId; // legacy dialect quirk
```

One line, typed, documented — instead of a forked adapter.

**Step 4 — the model catalog is generated.** Providers declare models; a script renders `models.generated.ts` (context windows, pricing tiers, reasoning capabilities). Never hand-edited. `pi update --models` refreshes it.

## In Real Pi

| Course concept | Real location |
|---|---|
| `Api` / `Provider` / `Compat` types | `pi/packages/ai/src/types.ts` |
| 10 wire protocol implementations | `pi/packages/ai/src/api/*.ts` (all lazy-loaded) |
| 40+ provider registrations | `pi/packages/ai/src/providers/` + `providers/all.ts` |
| OpenAI compat matrix (~25 boolean flags) | `OpenAICompletionsCompat` in `ai/src/types.ts` |
| Generated model catalog | `pi/packages/ai/src/models.generated.ts` |
| Faux provider for testing | `pi/packages/ai/src/providers/faux.ts` |

## Try It

```sh
node s05_provider_matrix/code.ts
```

One identical conversation is serialized three ways: Anthropic wire format, standard OpenAI-compat, and legacy OpenAI-compat. Diff the JSON outputs by eye — the tool-result message differs by exactly the compat flag, nothing else. Then watch the catalog lookup: `deepseek-chat → provider, context window, price`.

## What's Next

The kernel is nearly complete — but every capability so far was built *in*. pi's masterstroke is what it refuses to build in: permissions, sub-agents, MCP. s06 opens the kernel sideways: the extension system.
