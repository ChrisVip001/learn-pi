# s08: Session Tree — Sessions Branch in Place

[English](README.md) · [中文](README.zh.md)

[s07](../s07_minimal_kernel/) → `s08` → [s09](../s09_compaction/) → ... → s10
> *"Sessions branch in place."* — One JSONL file per session; every entry carries `id` + `parentId`; forking moves a pointer, it never copies a file.

---

## The Problem

Real agent work is exploratory: *"try approach A… actually, go back and try B from the same point."* A linear history can only move forward. Your options with a list-based session: copy the entire transcript into a new file (storage explodes, shared history diverges silently), or destroy branch A (lose work).

The same dilemma kills resume: "continue this session, but from that turn" requires surgery on the transcript.

## The Solution

pi's session format (v3) makes the persistence layer a **tree** with one file:

```
u1 ── a1 ── fb ── a2        <- branch A ("JSONL only")
└── b1 ── t1 ── b2          <- branch B ("SQLite + JSONL"), forked from u1
```

Every entry is one JSONL line carrying `id` and `parentId`. The **head** is a pointer into the tree. Branching = moving the head; the next append grows a new branch — in place, in the same file, without touching a single existing line.

## How It Works

**Step 1 — append-only persistence.** `append(entry)` assigns `id`, links `parentId = head`, moves head, writes one JSON line. Nothing is ever rewritten — crash-safe and git-diffable.

**Step 2 — branch is a pointer move.** `branch(entryId)` sets `head = entryId`. The next `append` creates the fork. Branch A's entries remain untouched and reachable.

**Step 3 — the model context is a projection.** `toMessages()` walks from head to root, reverses, and maps entries to message objects. The LLM only ever sees one path — the tree is the storage shape, the path is the context shape. (Extensions can append `custom` entries via `pi.appendEntry()`; they project into system text.)

**Step 4 — the file is the whole truth.** `load(file)` replays every line and rebuilds the tree — no sidecar state, no database. Fork, resume, transcript export all derive from the same file.

**Step 5 — v1 migrates for free.** Old linear sessions (no `parentId`) upgrade by linking each entry to its predecessor — pi does this automatically in `src/migrations.ts`.

## In Real Pi

| Course concept | Real location |
|---|---|
| JSONL tree format (v3), `id`/`parentId` | `pi/packages/coding-agent/src/core/session-manager.ts` + `docs/session-format.md` |
| v1/v2 → v3 automatic migration | `pi/packages/coding-agent/src/migrations.ts` |
| Tree navigation UI (`/tree`) | `pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts` (48KB component) |
| Branch summarization on switch | `pi/packages/coding-agent/src/core/compaction/branch-summarization.ts` |
| Custom entries from extensions | `pi.appendEntry()` in `extensions/types.ts` |
| Session export (HTML/JSONL) & sharing | `session-manager.ts`, export templates with highlight.js + mermaid |
| Alternative backends (SQLite) | `pi/packages/session-backends/sqlite-node/` |

## Try It

```sh
node s08_session_tree/code.ts
```

Watch the tree render three times: branch A alone; branch B forked from `u1` (note `b1`'s parent is `u1`, same file); then navigated back to A's tip — the model-visible context shrinks back to A's path. Finally the store reloads from disk alone.

## What's Next

Trees grow, and context windows overflow. pi's compaction walks **backwards from the newest entry**, keeps a recent-token budget, finds a legal cut point — and has one inviolable rule: never separate a tool call from its result. s09 builds it.
