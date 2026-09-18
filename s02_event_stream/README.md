# s02: Event Stream — Everything the Loop Does Is an Event

[English](README.md) · [中文](README.zh.md)

[s01](../s01_agent_loop/) → `s02` → [s03](../s03_schema_tools/) → ... → s10
> *"Everything the loop does is an event."* — The kernel emits; consumers decide what events mean.

---

## The Problem

s01's loop is a black box function: it runs to completion, then returns. While it runs you can see nothing. Now add requirements: show streaming text in a TUI, write a session log, run tests that assert on tool order, let an extension react before every tool call…

If you satisfy each requirement with a `console.log` here and a callback parameter there, the kernel rots. Every feature adds a seam directly into the loop.

## The Solution

```
agent_start
  turn_start
    message_start → message_update … → message_end
    tool_execution_start → tool_execution_end
  (repeat turns while toolCalls arrive)
agent_end  ← terminal event
```

The loop becomes an **async generator** that yields typed events. It prints nothing, writes nothing, calls nobody. Everything else — rendering, logging, testing, extending — attaches *outside* the kernel as an event consumer.

This is pi's central architectural decision: `agentLoop()` returns an `EventStream<AgentEvent, AgentMessage[]>`, and the entire product (TUI, session persistence, extensions, RPC mode) is built as consumers of that stream.

## How It Works

**Step 1 — define the event vocabulary.** A discriminated union covers the lifecycle: `agent_start`, `turn_start`, `message_start`, `message_update` (streaming deltas), `message_end`, `tool_execution_start/end`, `agent_end`. Every field is data — never a function — so events serialize to JSONL for free.

**Step 2 — the kernel yields instead of printing.**

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

**Step 3 — consumers attach from outside.** The chapter's `main()` iterates the stream once and forwards every event to two consumers: a terminal renderer (colors, streaming print) and a JSONL logger. A test harness would be a third consumer; pi's TUI is a fourth; its RPC mode a fifth.

**Step 4 — streaming is just an event.** The faux provider now yields text chunks. The kernel forwards each as `message_update` while accumulating the full text. The model channel and the display channel carry the same truth — one is data, the other is a view.

## In Real Pi

| Course concept | Real location |
|---|---|
| `EventStream<AgentEvent, AgentMessage[]>` | `pi/packages/agent/src/agent-loop.ts` — `agentLoop()` |
| Full event vocabulary (`agent_start` … `agent_end`, ~15 types) | `pi/packages/agent/src/types.ts` |
| Streamed `message_update` events | `pi/packages/agent/src/agent-loop.ts` — `streamAssistantResponse()` |
| Event consumers (TUI, JSONL sessions, RPC) | `pi/packages/coding-agent/src/modes/` |

Real pi's stream additionally supports multiple simultaneous subscribers and a terminal *return value* distinct from events — the concepts, not the API surface, are what transfers.

## Try It

```sh
node s02_event_stream/code.ts
```

Watch: assistant text prints **as it streams** (chunk by chunk, not all at once); tool executions appear as paired start/end events; the event log lands in `events.jsonl` inside the temp workspace — open it and read the raw JSON lines.

## What's Next

The loop emits events, but its tool dispatch is still a raw map of `(args) => string`. Model-generated arguments arrive unvalidated; there is no schema; no way to run safe tools in parallel. s03 makes tools **schema-first citizens**.
