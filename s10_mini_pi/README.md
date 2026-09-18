# s10: mini-pi — Thin Kernel, Thick Ecosystem

[English](README.md) · [中文](README.zh.md)

[s09](../s09_compaction/) → `s10` (end)
> *"Thin kernel, thick ecosystem."* — Every mechanism from s01–s09 in one runtime, ~330 lines — then two proofs that it bends without breaking.

---

## The Problem

Mechanisms learned in isolation can still fail in integration: does compaction compose with the session tree? Do extension tools join the same registry as built-ins? Does a fork see branch A's compaction entries? The final chapter wires everything together and runs the stress tests.

## The Solution

mini-pi is one runtime assembled from the nine previous chapters:

```
runAgent(store, steps):
  for each step:
    append assistant entry          (s08 session tree, JSONL, id/parentId)
    for each toolCall:
      runner.dispatch("tool_call")  (s06 extensions -> may block, s07 guardrails)
      execute from ONE registry     (s03 schema tools + extension tools)
      append toolResult entry       (s04 content channel)
    maybeCompact(store)             (s09 after every batch, log-preserving)
  context = store.toMessages()      (s08 projection honoring s09 boundaries)
```

Then the two integration proofs:

1. **A guardrail fires mid-run.** The scripted model tries `rm -rf /`; the extension blocks it; the model adapts and finishes. Kernel unchanged.
2. **The session forks.** `branch(firstAssistantId)` + one new user entry + a second scripted run — both branches live in one JSONL file; the tree renders with `< head` on the alternate path; the model-visible context is exactly branch B's path.

Compaction composes with the tree: the compaction entry is **just another entry** — appended as a child of the head. Fork away from it, and it vanishes from the projection while remaining in the log.

## In Real Pi

mini-pi mirrors, at 1/500th the scale, the composition inside pi:

| mini-pi piece | Real pi |
|---|---|
| `runAgent` loop | `agent-loop.ts` + `agent-session.ts` (product wiring) |
| One tool registry | `agent-session.ts` `_refreshToolRegistry()` — built-ins and extension tools merge |
| Extension runner + guardrail | `extensions/runner.ts` + examples/extensions |
| Session tree + compaction entries | `session-manager.ts` + `compaction/compaction.ts` |
| `toMessages` projection | request assembly in `agent-session.ts` |
| Faux/real provider switch | `ai/src/providers/faux.ts` vs 40+ real providers |

## Try It

```sh
node s10_mini_pi/code.ts
```

Follow the run: three tool turns (including the extension-contributed `count_files`), the guardrail blocking `rm -rf /` with the model adapting, a compaction entry appearing (purple) once the token budget overflows, then the fork — the tree at the end shows **both branches in one file**, head on the alternate path.

With a real model (single-shot answer mode; wiring real tool-calling through is left as the final exercise):

```sh
PI_API_KEY=sk-... node s10_mini_pi/code.ts "Summarize the workspace readme"
```

## What's Next

You have rebuilt pi's architecture from first principles. Where to go from here:

- **Read the real thing.** Start with `pi/packages/agent/src/agent-loop.ts` (858 lines — you now know every concept in it), then `extensions/types.ts` (the contract that makes it all extensible).
- **Write a real extension.** `pi/packages/coding-agent/docs/extensions.md` (120KB) — build the permission popup, the plan mode, the MCP bridge you watched being pushed out of the kernel.
- **Compare with learn-claude-code.** Same loop, opposite philosophy: mechanisms in vs. mechanisms out. Understanding both is understanding the design space.

**Thin kernel, thick ecosystem. The model will do the rest.**
