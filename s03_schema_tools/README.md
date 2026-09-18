# s03: Schema-First Tools — A Tool Is a Schema Plus a Handler

[English](README.md) · [中文](README.zh.md)

[s02](../s02_event_stream/) → `s03` → [s04](../s04_tool_results/) → ... → s10
> *"A tool is a schema plus a handler."* — The schema faces the model; the handler faces the kernel; validation sits between them.

---

## The Problem

s02 dispatched tools through a raw map of `(args) => string`. Three problems follow:

1. **No validation.** A model that omits `path` or sends `{ cmd: "ls" }` instead of `{ command: "ls" }` crashes the handler. The loop dies on a typo.
2. **No concurrency story.** Reading two files concurrently is safe and fast; two shell commands concurrently can corrupt each other. The dispatch map cannot tell them apart.
3. **No change notice.** When a tool appears mid-session (installed by an extension), the model has no idea — it keeps calling the old tool set, or hallucinates the new one.

## The Solution

pi's `AgentTool` answers all three with structure, not policy:

```ts
interface AgentTool<S extends Schema> {
  name: string;
  description: string;
  parameters: S;                                  // schema-first
  executionMode: "sequential" | "parallel";       // concurrency is a tool fact
  prepareArguments?: (args) => args;              // compat shim for sloppy models
  execute: (args: Infer<S>) => string;            // typed by the schema
}
```

Plus one kernel-side rule with big consequences: **when the tool set changes, the change is declared into the session history** as its own message. The model is told; the replay stays faithful; tool availability becomes part of the conversation.

## How It Works

**Step 1 — a 40-line TypeBox.** `T.object({ path: T.string() })` builds a composable schema; `type Infer<S>` derives the *TypeScript type* from the schema, so `execute` arguments are statically typed. This is exactly why pi chose TypeBox: the schema is the type — no duplicate declarations.

**Step 2 — validation before execution.** `validate(schema, args)` walks the schema. Invalid arguments become a normal error `toolResult` — the model sees its mistake and corrects itself next turn. **Nothing crashes; the turn continues.**

**Step 3 — the compat shim.** `prepareArguments` repairs dialect drift (a model sending `cmd` instead of `command`). pi gives every tool this hook instead of special-casing models in the kernel.

**Step 4 — batches split by mode.** A model-issued batch of parallel tools runs under `Promise.all`; sequential tools run one at a time afterwards. Note what is *not* here: a global concurrency policy. Each tool declares its own mode.

**Step 5 — `declareToolChanges`.** When the registry gains (or loses) a tool, the kernel appends a system message: `[tool changes] Tools added: grep`. In real pi this message carries `toolsAdded`/`toolsRemoved` and is part of the persisted session — replaying the session replays the tool set evolution.

## In Real Pi

| Course concept | Real location |
|---|---|
| `AgentTool` interface (`executionMode`, `prepareArguments`) | `pi/packages/agent/src/types.ts` |
| Schema validation before handlers | `pi/packages/agent/src/agent-loop.ts` — `prepareToolCall()` |
| Sequential/parallel batches, ordered results | `pi/packages/agent/src/agent-loop.ts` — `executeToolCalls()` |
| Tool changes declared into history | `pi/packages/agent/src/agent-loop.ts` — `declareToolChanges()` |
| TypeBox everywhere | every tool in `pi/packages/coding-agent/src/core/tools/` |
| Built-in tools (only eight!) | read, bash, edit, write, grep, find, ls, powershell |

## Try It

```sh
node s03_schema_tools/code.ts
```

Observe three moments: turn 1's batch mixes two `read`s (parallel), one `bash` (sequential), and one **invalid `grep` call** — watch it fail as an ordinary error result while the loop continues. Before turn 2, `grep` gets installed and a purple `[tool changes]` line enters the history. The shim silently repairs `{ cmd: "ls" }` → `{ command: "ls" }`.

## What's Next

Tools return a single string. But pi splits what a tool *tells the model* from what it *shows the user* — different channels, different shapes. s04 builds the dual-channel result, streaming partial results, and the defense against truncated model messages.
