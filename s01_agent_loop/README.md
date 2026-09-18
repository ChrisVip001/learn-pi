# s01: Agent Loop — The Kernel Is a Loop

[English](README.md) · [中文](README.zh.md)

`s01` → [s02](../s02_event_stream/) → s03 → ... → s10
> *"The loop is the kernel."* — No tool calls in the response? Stop. Tool calls? Execute, feed back, repeat.

---

## The Problem

A model can *write* a bash command, but it cannot *run* it. Without a harness you are the harness: copy the command into a terminal, paste the output back, wait for the next command, repeat.

Every manual round-trip you perform is one iteration of a loop. Automating that loop is the entire job description of an agent kernel.

## The Solution

```
   user prompt ──► messages[] ──► LLM ──► response content blocks
                                            │
                              contains toolCall blocks?
                              /                        \
                            yes                         no
                             │                          │
                       execute handlers                stop
                       append toolResult
                       loop back ──────────► messages[]
```

Two design choices distinguish the pi flavor of this loop from a generic agent loop:

1. **A unified message model.** Four roles only: `system`, `user`, `assistant`, `toolResult`. Assistant messages are lists of typed content blocks (`text` | `toolCall`). This is a miniature of pi-ai's message vocabulary — one model, every provider.
2. **A scripted FauxProvider.** The default LLM backend is fully offline and deterministic. Pi ships exactly this idea (`faux.ts`) so its test suite never spends a cent and never flakes. We adopt it for the whole course: every chapter runs with `node code.ts`, no key needed.

## How It Works

**Step 1 — tools are two things, not one.** A `ToolSchema` (what the model sees) and a handler in a dispatch map (what the kernel runs). The model never sees handler code; the kernel never parses prose.

**Step 2 — the loop checks blocks, not a flag.** After each LLM response, filter content blocks for `toolCall`. Zero matches → the model decided to stop → return. This single rule is the whole control flow.

**Step 3 — results are addressed messages.** Each `toolResult` references its `toolCallId`. The model gets an unambiguous answer for each call it made.

```ts
async function agentLoop(messages, llm) {
  while (true) {
    const response = await llm(messages, TOOLS);
    messages.push({ role: "assistant", content: response.content });

    const toolCalls = response.content.filter((b) => b.type === "toolCall");
    if (toolCalls.length === 0) return;          // model chose to stop

    for (const call of toolCalls) {
      const output = TOOL_HANDLERS[call.name](call.arguments);
      messages.push({ role: "toolResult", toolCallId: call.id, content: output });
    }
  }
}
```

**Step 4 — the workspace is disposable.** The demo creates a throwaway directory under your temp folder. The kernel never runs model commands in your real project — safety by default, not by permission popup (that theme returns in s07).

## In Real Pi

| Course concept | Real location |
|---|---|
| Two-layer while loop, follow-up queue | `pi/packages/agent/src/agent-loop.ts` — `runLoop()` |
| Unified message model | `pi/packages/ai/src/types.ts` |
| FauxProvider | `pi/packages/ai/src/providers/faux.ts` |
| Product-level loop wiring | `pi/packages/coding-agent/src/core/agent-session.ts` |

The real loop adds steering (interject while streaming), retries, and abort handling — but the `toolCall`-present check at its heart is exactly the one above.

## Try It

```sh
node s01_agent_loop/code.ts
```

Watch: turn 1 calls `ls`, turn 2 writes `summary.txt` (both tool turns print in yellow), turn 3 contains no `toolCall` → loop exits. The faux script is fixed, so output is byte-identical on every run.

With a real model (any OpenAI-compatible endpoint):

```sh
PI_API_KEY=sk-... PI_BASE_URL=https://api.deepseek.com PI_MODEL=deepseek-chat \
  node s01_agent_loop/code.ts "rename summary.txt to report.txt"
```

## What's Next

Right now the loop is a function that returns when it's done. You cannot render progress while it runs, log events, or attach a UI. pi's answer: **the loop is not a function — it is an event stream.** s02 turns the kernel inside out.
