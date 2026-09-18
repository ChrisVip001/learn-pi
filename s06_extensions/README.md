# s06: Extensions — The Kernel Hosts; Extensions Act

[English](README.md) · [中文](README.zh.md)

[s05](../s05_provider_matrix/) → `s06` → [s07](../s07_minimal_kernel/) → ... → s10
> *"The kernel hosts; extensions act."* — Extensions subscribe to typed events, contribute tools and commands, and can block anything — all without touching the kernel.

---

## The Problem

Your agent needs: a permission prompt before dangerous commands, a custom deploy tool, secret redaction on outgoing requests, a `/release` command, a linter check after every edit…

The conventional answer adds each feature to the core: a `if (dangerous)` branch here, a redaction call there. Six months later the "core" is an unreviewable pile of product-specific logic, and none of it can be uninstalled.

## The Solution

pi's answer is an event-driven extension system — the single most important file in the codebase is its contract (`extensions/types.ts`, ~1800 lines):

```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (ev) => {                 // ~40 event types in real pi
    if (isDangerous(ev)) return { block: true, reason: "..." };
  });
  pi.on("before_provider_request", (ev) => {   // mutate the outgoing payload
    redact(ev.request.messages);
  });
  pi.registerTool({ name: "deploy", ... });    // contribute capabilities
  pi.registerCommand("release", ...);
}
```

Extensions are **discovered from disk** (`.pi/extensions/` in the project, `~/.pi/agent/extensions/` globally), loaded by a runner, and dispatched on every event. The kernel emits events; it has no idea what extensions exist.

## How It Works

**Step 1 — typed events with block semantics.** Handlers receive a precisely-typed event (`Extract<ExtensionEvent, { type: "tool_call" }>`). A handler may return `{ block, reason }` — the runner aggregates and the *first* block wins. Blocking is data, not exceptions.

**Step 2 — mutation hooks.** `before_provider_request` handlers receive the outgoing payload object and mutate it in place. The redactor extension replaces `secret-*` tokens — secrets never reach the wire.

**Step 3 — contributions.** `registerTool` feeds the same tool registry from s03 (schema + handler + execution mode), so an extension tool is indistinguishable from a built-in. `registerCommand` adds slash commands the same way.

**Step 4 — discovery.** The loader scans `.pi/extensions/` and dynamically imports each module. This chapter writes a real `weather.mjs` to a temp project directory and loads it from disk — exactly the flow of pi's loader (which uses **jiti** so extensions can be plain TypeScript, no build step).

**Step 5 — the loop consults the runner.** Before executing any tool: `runner.dispatch({ type: "tool_call", ... })`. A block becomes a synthetic error `toolResult` — the model learns the boundary and adapts, without the kernel containing one byte of policy.

## In Real Pi

| Course concept | Real location |
|---|---|
| `ExtensionAPI` contract (~40 events, registerTool/Command/Provider/…) | `pi/packages/coding-agent/src/core/extensions/types.ts` |
| Loader (jiti, `.pi/extensions/` + global dir) | `pi/packages/coding-agent/src/core/extensions/loader.ts` |
| Event dispatch runner | `pi/packages/coding-agent/src/core/extensions/runner.ts` |
| Per-tool typed events (`BashToolCallEvent`, …) | `extensions/types.ts` |
| Project trust gate for loading project extensions | `pi/packages/coding-agent/src/core/trust-manager.ts` |
| `ctx.ui` surface (select/confirm/notify/widgets) | `extensions/types.ts` |

Real pi also gates loading: project-level extensions only load when the project is **trusted** (first-run prompt) — that's the whole built-in security story, and s07 builds on it.

## Try It

```sh
node s06_extensions/code.ts
```

Watch the load lines: the `weather` tool arrives from disk (purple `[ext:weather.mjs]`), `guardrails` and `redactor` register inline. Then: turn 1 calls the extension tool; turn 2's `rm -rf` gets **blocked with the extension's reason**; the outgoing request shows `secret-abc123` → `[REDACTED]`.

## What's Next

You now have every ingredient for pi's thesis. s07 assembles the payoff: permission approval, a sub-agent, and an MCP-style external tool — **all three as extensions, kernel untouched.**
