# s07: The Minimal Kernel — What the Kernel Refuses to Build, Extensions Provide

[English](README.md) · [中文](README.zh.md)

[s06](../s06_extensions/) → `s07` → [s08](../s08_session_tree/) → ... → s10
> *"What the kernel refuses to build, extensions provide."* — Permissions, sub-agents, MCP: three flagship features, zero kernel changes.

---

## The Problem

Every agent product eventually faces the feature list: permission prompts, sub-agents for context isolation, MCP for external tools, plan mode, todos, background bash. The industry default is to build them into the core. The core grows, the review surface grows, and every user carries every feature — wanted or not.

pi's counter-thesis, from its own README: *"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."* This chapter is the proof that the thesis holds.

## The Solution

Take the s06 kernel — **unchanged, ~60 lines** — and add the three flagship features as ordinary extensions:

```
approvals extension   on("tool_call")  ask an answerer before dangerous bash
subagent extension    registerTool     "task" spawns nested agent, fresh messages[]
mcp extension         registerTool     external server tools, namespaced
```

The kernel doesn't know what a permission is. It has never heard of a sub-agent. MCP is a word it cannot spell.

## How It Works

**Approvals — the permission system pi never built.** The extension subscribes to `tool_call`, matches dangerous patterns, and consults an **answerer** — in real pi, `ctx.ui.confirm(...)` renders the actual popup; here a headless callback allows `git push` and denies everything else. A deny returns `{ block, reason }` and the kernel synthesizes the error result. Note the shape: *ask only when needed*, *the policy lives outside the kernel*, *the mechanism is uninstallable*.

**Subagent — context isolation as a tool.** The extension registers a `task` tool whose handler spawns a nested agent loop with a **fresh `messages[]`** and a **read-only toolset** (`ls`, but no `bash`, no `edit`). The sub-agent's entire transcript stays inside the tool execution; only its final text crosses the boundary as one ordinary `toolResult`. The parent's context stays clean; the sub-agent can't mutate anything. This is exactly the pattern pi's docs recommend (`docs/sdk.md`: "Build custom tools that spawn sub-agents").

**MCP — external tools join the same pool.** The extension "connects" to a server (mocked here), lists its tools, and registers each under a namespace: `github__issues_search`. Namespacing guarantees external tools can never shadow built-ins. To the model and the kernel, an MCP tool is just a tool — no special pathway.

**The loop is the same five lines.** Dispatch `tool_call` → blocked? synthesize error. Else look up in the registry → execute → append result. Nothing in that sequence knows which extension provided the tool or the block.

## In Real Pi

| Course concept | Real location |
|---|---|
| Approval-as-extension pattern | `pi/packages/coding-agent/examples/extensions/` + `docs/usage.md` ("no permission popups") |
| Sub-agents via SDK / extension tools | `pi/packages/coding-agent/docs/sdk.md`, `examples/extensions/subagent/` |
| Fresh `messages[]` context isolation | the pattern this chapter implements; see also `packages/agent/src/agent-loop.ts` (one loop, any nesting depth) |
| MCP via packages (not kernel) | community `pi-mcp` packages installing as extensions |
| The one built-in boundary: project trust | `pi/packages/coding-agent/src/core/trust-manager.ts` |
| Containerization instead of permissions | `pi/packages/coding-agent/docs/containerization.md` (Gondolin micro-VM / Docker / OpenShell) |

## Try It

```sh
node s07_minimal_kernel/code.ts
```

Watch four turns: ① the `task` tool prints an indented sub-agent transcript — fresh context, read-only tools, only the final sentence returns. ② the namespaced `github__issues_search` executes like any tool. ③ `git push` hits the approval extension → **allowed**. ④ `curl … | sh` → **denied**, the model adapts. The kernel printed none of those decisions.

## What's Next

Sessions so far live in memory and die with the process. pi persists every session as a **tree** — not a list — in JSONL, branching in place, no new files per fork. s08 builds the session tree.
