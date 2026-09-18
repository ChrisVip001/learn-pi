# s04: Tool Result Channels — `content` for the Model, `details` for the UI

[English](README.md) · [中文](README.zh.md)

[s03](../s03_schema_tools/) → `s04` → [s05](../s05_provider_matrix/) → ... → s10
> *"`content` for the model, `details` for the UI."* — One result, two channels; plus the defense that saves you from truncated model messages.

---

## The Problem

A tool returns a string. Everyone eats the same string:

- The **model** needs the essence ("edited config.txt, +1 line") — every byte costs tokens forever.
- The **UI** wants the riches — the full colored diff, the exit code, the changed paths.
- Neither wants the other's payload: diffs bloat context; plain summaries bore users.

And a second, nastier problem: when a model message hits the output token limit, it can end **mid-tool-call** — half-written JSON arguments. Executing that command means executing corruption.

## The Solution

```ts
type AgentToolResult<TDetails> = {
  content: TextBlock[];   // -> appended to messages[], priced in tokens
  details?: TDetails;     // -> renderer only, free
  terminate?: boolean;    // -> this result can end the agent
};
```

Plus one kernel rule: **`stopReason === "length"` with pending tool calls ⇒ never execute them.** Fail them with a synthetic `toolResult` explaining the truncation, and let the model re-send a smaller batch.

## How It Works

**Step 1 — split the channels.** The `edit` tool returns `content: "Edited config.txt (+1 lines)."` and `details: { path, linesChanged, diff }`. The renderer prints the full green diff; the model sees one short sentence. Context stays lean; the UI stays rich.

**Step 2 — stream partials through `onUpdate`.** Long-running tools receive an `onUpdate(partial)` callback. Each update refreshes the UI line; the model only ever receives the *final* content. In real pi this is `tool_execution_update`, and the TUI's spinner/progress components consume it.

**Step 3 — `terminate`.** A `task_complete` tool returns `terminate: true`. The kernel stops the loop after this result — no special-casing in the loop, the *tool result* carries the intent. (Real pi: if all calls in a batch terminate, the agent ends.)

**Step 4 — the truncation defense.**

```ts
if (response.stopReason === "length" && toolCalls.length > 0) {
  failToolCallsFromTruncatedMessage(toolCalls, messages); // synthetic error results
  continue;  // model reads the failures and re-sends a smaller batch
}
```

pi's `agent-loop.ts` does exactly this at line 434. Streaming JSON rescue parsing might *look* fine — pi chooses not to gamble.

## In Real Pi

| Course concept | Real location |
|---|---|
| `AgentToolResult` with `content` / `details` / `terminate` | `pi/packages/agent/src/types.ts` |
| Streaming partial results | `onUpdate` in tool `execute`, `tool_execution_update` event |
| Truncation defense | `pi/packages/agent/src/agent-loop.ts` — `failToolCallsFromTruncatedMessage()` |
| UI-channel renderers | `pi/packages/coding-agent/src/core/tools/renderers/*.ts` |
| Output truncation (head/tail budgets) | `pi/packages/coding-agent/src/core/tools/truncate.ts` |

## Try It

```sh
node s04_tool_results/code.ts
```

Follow the four turns: ① `edit` — watch the colored diff print **while the model's history only records one sentence**. ② The scripted model hits `stopReason: length` with a half-written `bash` call — the red warning fires, the call is failed, nothing executes. ③ The model re-sends a compact batch; `bash` streams progress lines. ④ `task_complete` returns `terminate` and the loop ends cleanly.

## What's Next

The kernel now runs one hard-coded faux provider. Real products need dozens of providers across ten wire protocols — without writing N×M adapters. s05 builds the API × Provider orthogonality that lets pi serve 40+ providers with 10 protocol implementations.
