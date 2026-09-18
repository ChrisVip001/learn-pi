# s09: Compaction — Never Cut Between a Call and Its Result

[English](README.md) · [中文](README.zh.md)

[s08](../s08_session_tree/) → `s09` → [s10](../s10_mini_pi/) → s10
> *"Never cut between a call and its result."* — Walk backwards from the newest entry, respect the budget, find a legal boundary, summarize the rest.

---

## The Problem

Long tasks overflow any context window. The naive fix — truncate the oldest messages — silently corrupts the conversation: cut in the wrong place and an assistant's `toolCall` loses its `toolResult` (or a result arrives orphaned). Most providers **reject the request**; the ones that don't will confuse the model. The agent dies at exactly the moment it is being most useful — deep in a long task.

## The Solution

pi's compaction is a four-step algorithm with one inviolable rule:

```
trigger:   contextTokens > contextWindow - reserveTokens
step 1:    walk BACKWARDS from newest, accumulate until keepRecentTokens
step 2:    adjust cut to a LEGAL boundary          <- the rule lives here
step 3:    summarize everything before the cut
step 4:    request = system + summary + kept entries   (log stays append-only)
```

The rule: **a `toolResult` must never be separated from the assistant message that requested it.** If the backwards walk lands mid-pair, the boundary moves back until call and result stay together.

## How It Works

**Step 1 — trigger discipline.** Not a timer, not "every N turns": the check runs after each tool batch, before each user prompt, and after each agent run — exactly the moments the context can have grown. `/compact [instructions]` forces it manually with custom guidance.

**Step 2 — the backwards walk.** Token estimation (chars/4) accumulates from the newest entry until `keepRecentTokens` is covered. Walking backwards — not forwards — guarantees the *most recent* work is always the protected region.

**Step 3 — the legal-boundary adjustment.**

```ts
while (entries[cut].type === "toolResult") {
  cut--;  // pull the paired assistant call into the kept region
}
```

One loop; requests never contain orphaned results.

**Step 4 — projection vs. log.** Compaction shrinks the **request projection**, never the **session log**. The JSONL tree from s08 stays append-only and complete — you can always export the full transcript, and replay stays faithful. (Real pi persists a `CompactionEntry` with `firstKeptEntryId`, so even compaction is an entry in the log.)

**Split turns.** One enormous turn (a single tool result bigger than the whole budget) gets **two summaries**: one for the history before it, one for the turn's own prefix — then the turn continues inside the budget.

## In Real Pi

| Course concept | Real location |
|---|---|
| Compaction algorithm (~30KB) | `pi/packages/coding-agent/src/core/compaction/compaction.ts` |
| Trigger points (`_checkCompaction`) | `agent-session.ts` — after batches, before prompts, after runs |
| Legal cut points, split-turn handling | `compaction.ts` |
| `CompactionEntry` with `firstKeptEntryId` | session format, `docs/session-format.md` |
| Branch summarization on tree switch | `compaction/branch-summarization.ts` |
| Extension takeover (`session_before_compact`) | `extensions/types.ts` |
| agent-core's independent implementation | `pi/packages/agent/src/harness/compaction/compaction.ts` |

## Try It

```sh
node s09_compaction/code.ts
```

The session (8 entries, huge tool outputs) exceeds the deliberately tiny 900-token window. Watch: the backwards walk lands between `c3`'s call and result — the boundary **steps back** to keep the pair together; the older region becomes a purple summary; the request context drops from ~1100 to ~400 tokens while the log stays 8 entries.

## What's Next

All nine mechanisms are built. s10 assembles them into **mini-pi**: event-driven loop + schema tools + extensions + session tree + compaction, one runtime, ~300 lines — and proves the kernel still bends without breaking.
