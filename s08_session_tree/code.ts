#!/usr/bin/env node
/**
 * s08_session_tree.ts - Sessions Are Trees, Not Lists
 *
 * A linear chat history can only move forward. But real agent work forks:
 * "try approach A... actually, let's try B from that same point". A list
 * forces you to either copy the whole transcript (new file) or lose A.
 *
 * pi's session format (docs/session-format.md, v3):
 *   - one JSONL file per session, one entry per line
 *   - every entry carries id + parentId -> the file IS a tree
 *   - branching = moving the head pointer; the file never forks into copies
 *   - v1 (linear) sessions migrate to v3 automatically
 *
 *   user(u1) ── asst(a1) ── user(u2) ── asst(a2)      <- branch "approach A"
 *        └─────── asst(a3) ── user(u4) ── asst(a4)    <- branch "approach B"
 *              (a3's parentId is u1: forked in place, same file)
 *
 * Usage: node s08_session_tree/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 1. Entries: id + parentId make an append-only log into a tree
// ---------------------------------------------------------------------------

type EntryPayload =
	| { type: "user"; text: string }
	| { type: "assistant"; text: string }
	| { type: "toolResult"; toolCallId: string; content: string }
	| { type: "custom"; kind: string; data: unknown }; // extensions appendEntry()

interface SessionEntry {
	id: string;
	parentId: string | null;
	createdAt: string;
	payload: EntryPayload;
}

// ---------------------------------------------------------------------------
// 2. The store: append, branch in place, project head -> messages, persist
// ---------------------------------------------------------------------------

class SessionStore {
	private nextId = 1;
	private entries = new Map<string, SessionEntry>();
	private head: string | null = null;
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	append(payload: EntryPayload): SessionEntry {
		const entry: SessionEntry = {
			id: `e${this.nextId++}`,
			parentId: this.head,
			createdAt: new Date().toISOString(),
			payload,
		};
		this.entries.set(entry.id, entry);
		this.head = entry.id;
		appendFileSync(this.file, `${JSON.stringify(entry)}\n`); // append-only
		return entry;
	}

	/** Fork: move the head to ANY entry. The next append branches in place. */
	branch(entryId: string): void {
		if (!this.entries.has(entryId)) throw new Error(`no such entry: ${entryId}`);
		this.head = entryId;
	}

	/** Project the path root -> head into a flat message list for the LLM. */
	toMessages(): Array<{ role: string; content: string }> {
		const path: SessionEntry[] = [];
		let cursor = this.head;
		while (cursor) {
			const entry = this.entries.get(cursor)!;
			path.unshift(entry);
			cursor = entry.parentId;
		}
		return path.map((e) => {
			switch (e.payload.type) {
				case "user":
					return { role: "user", content: e.payload.text };
				case "assistant":
					return { role: "assistant", content: e.payload.text };
				case "toolResult":
					return { role: "toolResult", content: e.payload.content };
				default:
					return { role: "system", content: `[${e.payload.kind}] ${JSON.stringify(e.payload.data)}` };
			}
		});
	}

	/** ASCII rendering of the whole tree; '>' marks the current head. */
	renderTree(): string {
		const children = new Map<string | null, SessionEntry[]>();
		for (const e of this.entries.values()) {
			const list = children.get(e.parentId) ?? [];
			list.push(e);
			children.set(e.parentId, list);
		}
		const lines: string[] = [];
		const walk = (parentId: string | null, indent: string) => {
			for (const child of children.get(parentId) ?? []) {
				const label =
					child.payload.type === "custom"
						? `${child.payload.kind}:${JSON.stringify(child.payload.data)}`
						: `${child.payload.type}: ${child.payload.text?.slice(0, 40) ?? child.payload.content.slice(0, 40)}`;
				const marker = child.id === this.head ? " \x1b[32m< head\x1b[0m" : "";
				lines.push(`${indent}${child.id} ${label}${marker}`);
				walk(child.id, `${indent}  `);
			}
		};
		walk(null, "");
		return lines.join("\n");
	}

	/** Reload: the JSONL file alone reconstructs the full tree. */
	static load(file: string): SessionStore {
		const store = new SessionStore(file);
		if (!existsSync(file)) return store;
		let last: string | null = null;
		for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
			const entry = JSON.parse(line) as SessionEntry;
			store.entries.set(entry.id, entry);
			const n = Number(entry.id.slice(1));
			if (n >= store.nextId) store.nextId = n + 1;
			last = entry.id;
		}
		store.head = last;
		return store;
	}
}

// ---------------------------------------------------------------------------
// 3. Demo: two approaches forked from the same question, in one file
// ---------------------------------------------------------------------------

function main() {
	const file = join(mkdtempSync(join(tmpdir(), "mini-pi-s08-")), "session.jsonl");
	writeFileSync(file, "");
	console.log(`s08: Session Tree\nsession file: ${file}\n`);

	const store = new SessionStore(file);

	// -- branch A: the original conversation -------------------------------
	const u1 = store.append({ type: "user", text: "Should we use SQLite or plain JSONL for sessions?" });
	store.append({ type: "assistant", text: "A: JSONL - append-only, human-readable, git-friendly." });
	store.append({ type: "custom", kind: "user_feedback", data: { vote: "down", reason: "I need queries" } });
	const a1 = store.append({ type: "assistant", text: "A-end: Then SQLite with a JSONL export view." });

	console.log("\x1b[1m--- after branch A ---\x1b[0m");
	console.log(store.renderTree());

	// -- fork from u1: explore approach B without touching branch A --------
	store.branch(u1.id);
	store.append({ type: "assistant", text: "B: SQLite as the source of truth, JSONL as the audit log." });
	store.append({ type: "toolResult", toolCallId: "x1", content: "benchmark: sqlite 3x faster for lookups" });
	store.append({ type: "assistant", text: "B-end: SQLite primary + nightly JSONL snapshot." });

	console.log("\n\x1b[1m--- after forking from u1 (branch B is now head) ---\x1b[0m");
	console.log(store.renderTree());

	// -- navigate back to branch A's tip: same file, no copies --------------
	store.branch(a1.id);
	console.log("\n\x1b[1m--- navigated back to branch A's tip ---\x1b[0m");
	console.log(`model-visible context (${store.toMessages().length} messages):`);
	for (const m of store.toMessages()) console.log(`  \x1b[2m${m.role}: ${m.content.slice(0, 60)}\x1b[0m`);

	// -- reload from disk: the file alone reconstructs the tree -------------
	const reloaded = SessionStore.load(file);
	console.log(`\nreloaded ${reloaded.entries.size} entries from disk (head: ${reloaded.head})`);
	console.log("Both branches live in ONE file. Forking added zero copies.");

	// -- v1 -> v3 migration sketch (pi: src/migrations.ts) ------------------
	console.log("\nv1 (linear) migration: entries without parentId get parentId = previous line's id.");
	console.log("pi does this automatically on first open (src/migrations.ts).");
}

main();
