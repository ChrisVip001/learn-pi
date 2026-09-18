#!/usr/bin/env node
/**
 * s10_mini_pi.ts - Thin Kernel, Thick Ecosystem
 *
 * The graduation chapter: every mechanism from s01-s09 assembled into one
 * runtime, ~330 lines, zero dependencies.
 *
 *   event-driven loop (s01/s02) + schema-first tools (s03) + dual-channel
 *   results (s04) + provider matrix (s05, faux by default) + extensions
 *   (s06) + session tree (s08) + log-preserving compaction (s09)
 *
 * Then the two proofs that the kernel bends without breaking:
 *   1. an extension blocks a destructive command mid-run (s07 style)
 *   2. the session FORKS from an early entry and replays an alternate path
 *
 * Usage:
 *   node s10_mini_pi/code.ts                       # offline faux run
 *   PI_API_KEY=sk-... node s10_mini_pi/code.ts "task"   # real OpenAI-compatible model
 */

import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-pi-s10-"));
writeFileSync(join(WORKSPACE, "readme.md"), "# project\nthin kernel demo.\n".repeat(8));

// ---------------------------------------------------------------------------
// Messages, blocks, events (s01/s02)
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };
type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type AssistantBlock = TextBlock | ToolCallBlock;

// ---------------------------------------------------------------------------
// Schema-first tools (s03/s04)
// ---------------------------------------------------------------------------

const T = {
	object: (properties: Record<string, { type: string }>): Record<string, unknown> => ({
		type: "object",
		properties,
		required: Object.keys(properties),
	}),
};

interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>) => string;
}

const TOOLS: Tool[] = [
	{
		name: "bash",
		description: "Run a shell command in the workspace.",
		parameters: T.object({ command: { type: "string" } }),
		execute: (args) => {
			const r = spawnSync(String(args["command"] ?? ""), { shell: true, cwd: WORKSPACE, encoding: "utf8", timeout: 30_000 });
			return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 4000) || "(no output)";
		},
	},
	{
		name: "read",
		description: "Read a file.",
		parameters: T.object({ path: { type: "string" } }),
		execute: (args) => {
			try {
				return readFileSync(join(WORKSPACE, String(args["path"])), "utf8").slice(0, 4000);
			} catch {
				return `Error: cannot read '${String(args["path"])}'`;
			}
		},
	},
	{
		name: "edit",
		description: "Write a file's content.",
		parameters: T.object({ path: { type: "string" }, content: { type: "string" } }),
		execute: (args) => {
			writeFileSync(join(WORKSPACE, String(args["path"])), String(args["content"] ?? ""));
			return `Wrote ${String(args["path"])} (${String(args["content"] ?? "").length} chars).`; // content channel only
		},
	},
];

// ---------------------------------------------------------------------------
// Extensions (s06/s07)
// ---------------------------------------------------------------------------

type ExtensionEvent = { type: "tool_call"; name: string; arguments: Record<string, unknown> };
type BlockDecision = { block: true; reason: string };

class ExtensionRunner {
	private handlers: Array<(ev: ExtensionEvent) => void | BlockDecision> = [];
	readonly tools = new Map<string, Tool>();

	load(factory: (on: (h: (ev: ExtensionEvent) => void | BlockDecision) => void, registerTool: (t: Tool) => void) => void): void {
		factory((h) => this.handlers.push(h), (t) => this.tools.set(t.name, t));
	}

	dispatch(ev: ExtensionEvent): BlockDecision | undefined {
		for (const h of this.handlers) {
			const r = h(ev);
			if (r && r.block) return r;
		}
		return undefined;
	}
}

const runner = new ExtensionRunner();
runner.load((on, registerTool) => {
	on((ev) => {
		if (ev.name === "bash" && String(ev.arguments["command"] ?? "").includes("rm -rf")) {
			return { block: true, reason: "guardrails: destructive command blocked" };
		}
	});
	registerTool({
		name: "count_files",
		description: "Count files in the workspace (contributed by an extension).",
		parameters: T.object({}),
		execute: () => `${readdirSync(WORKSPACE).length} files`,
	});
});

// ---------------------------------------------------------------------------
// Session tree (s08) + compaction entry (s09)
// ---------------------------------------------------------------------------

type Entry =
	| { type: "user"; text: string }
	| { type: "assistant"; blocks: AssistantBlock[] }
	| { type: "toolResult"; toolCallId: string; content: string }
	| { type: "custom"; kind: "compaction"; summary: string; firstKeptEntryId: string };

interface SessionEntry {
	id: string;
	parentId: string | null;
	payload: Entry;
}

class SessionStore {
	private nextId = 1;
	private entries = new Map<string, SessionEntry>();
	head: string | null = null;
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	append(payload: Entry): SessionEntry {
		const entry = { id: `e${this.nextId++}`, parentId: this.head, payload };
		this.entries.set(entry.id, entry);
		this.head = entry.id;
		appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
		return entry;
	}

	branch(entryId: string): void {
		this.head = entryId;
	}

	get(id: string): SessionEntry {
		return this.entries.get(id)!;
	}

	/** Head-to-root path (newest last). */
	path(): SessionEntry[] {
		const path: SessionEntry[] = [];
		let cursor: string | null = this.head;
		while (cursor) {
			const e = this.entries.get(cursor)!;
			path.unshift(e);
			cursor = e.parentId;
		}
		return path;
	}

	/** Model-visible context: honor compaction boundaries (s09). */
	toMessages(): Array<{ role: string; content: string }> {
		const path = this.path();
		const cut = path.findIndex((e) => e.payload.type === "custom" && e.payload.kind === "compaction");
		const kept = cut === -1 ? path : path.slice(cut + 1);
		const summary = cut === -1 ? null : (path[cut]!.payload as { summary: string }).summary;
		const msgs = kept.map((e) => {
			const p = e.payload;
			if (p.type === "user") return { role: "user", content: p.text };
			if (p.type === "assistant") return { role: "assistant", content: p.blocks.map((b) => (b.type === "text" ? b.text : `[${b.name}]`)).join(" ") };
			return { role: "toolResult", content: p.content };
		});
		return summary ? [{ role: "system", content: summary }, ...msgs] : msgs;
	}

	renderTree(): string {
		const children = new Map<string | null, SessionEntry[]>();
		for (const e of this.entries.values()) {
			const list = children.get(e.parentId) ?? [];
			list.push(e);
			children.set(e.parentId, list);
		}
		const lines: string[] = [];
		const walk = (parentId: string | null, indent: string) => {
			for (const c of children.get(parentId) ?? []) {
				const p = c.payload;
				const label = p.type === "custom" ? `\x1b[35m[compaction]\x1b[0m` : `${p.type}: ${("text" in p ? p.text : "toolCallId" in p ? p.content : "").slice(0, 34)}`;
				lines.push(`${indent}${c.id} ${label}${c.id === this.head ? " \x1b[32m< head\x1b[0m" : ""}`);
				walk(c.id, `${indent}  `);
			}
		};
		walk(null, "");
		return lines.join("\n");
	}
}

// -- compaction (s09), log-preserving ----------------------------------------

const WINDOW = 700;
const RESERVE = 120;
const KEEP_RECENT = 200;

const tokensOf = (text: string): number => Math.ceil(text.length / 4);
const entryTokens = (e: SessionEntry): number => {
	const p = e.payload;
	if (p.type === "toolResult") return tokensOf(p.content);
	if (p.type === "user") return tokensOf(p.text);
	if (p.type === "assistant") return p.blocks.reduce((s, b) => s + tokensOf(b.type === "text" ? b.text : b.name), 0);
	return 40;
};

function maybeCompact(store: SessionStore): void {
	const path = store.path();
	if (path.reduce((s, e) => s + entryTokens(e), 0) <= WINDOW - RESERVE) return;

	let kept = 0;
	let cut = path.length;
	while (cut > 0 && kept < KEEP_RECENT) {
		cut--;
		kept += entryTokens(path[cut]!);
	}
	while (cut < path.length && path[cut]!.payload.type === "toolResult") cut--;
	if (cut <= 0) return;

	const older = path.slice(0, cut);
	const summary = `[compacted ${older.length} messages] task: survey the workspace; tools used: ${[...new Set(older.filter((e) => e.payload.type === "toolResult").map((e) => (e.payload as { toolCallId: string }).toolCallId))].join(", ")}`;
	store.append({ type: "custom", kind: "compaction", summary, firstKeptEntryId: path[cut]!.id });
	console.log(`  \x1b[35m[compaction] ${older.length} entries -> 1 summary (log untouched, all ${store.path().length} entries preserved)\x1b[0m`);
}

// ---------------------------------------------------------------------------
// The agent loop (s01/s02): emits, executes, persists, compacts
// ---------------------------------------------------------------------------

type Step = { text: string; calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

async function runAgent(store: SessionStore, steps: AsyncGenerator<Step>): Promise<void> {
	for await (const step of steps) {
		const blocks: AssistantBlock[] = step.text ? [{ type: "text", text: step.text }] : [];
		for (const call of step.calls) blocks.push({ type: "toolCall", ...call });
		store.append({ type: "assistant", blocks });

		if (step.calls.length === 0) return;
		for (const call of step.calls) {
			console.log(`\x1b[33m⚡ ${call.name} ${JSON.stringify(call.arguments).slice(0, 70)}\x1b[0m`);
			const blocked = runner.dispatch({ type: "tool_call", name: call.name, arguments: call.arguments });
			const output = blocked
				? `Error: ${blocked.reason}`
				: (runner.tools.get(call.name) ?? TOOLS.find((t) => t.name === call.name))!.execute(call.arguments);
			console.log(`  \x1b[2m${output.slice(0, 90)}\x1b[0m`);
			store.append({ type: "toolResult", toolCallId: call.id, content: output });
		}
		maybeCompact(store); // s09: check after every tool batch
	}
}

// -- faux provider (scripted; s01) --------------------------------------------

async function* fauxSteps(script: Array<{ text: string; calls: Step["calls"] }>): AsyncGenerator<Step> {
	for (const step of script) yield { text: step.text, calls: step.calls };
}

// -- real provider (optional, s01/s05) -----------------------------------------

async function* realSteps(task: string, store: SessionStore): AsyncGenerator<Step> {
	const base = process.env.PI_BASE_URL ?? "https://api.deepseek.com";
	for (let i = 0; i < 10; i++) {
		const messages = store.toMessages();
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PI_API_KEY}` },
			body: JSON.stringify({
				model: process.env.PI_MODEL ?? "deepseek-chat",
				messages: messages.map((m) => ({ role: m.role === "toolResult" ? "tool" : m.role, content: m.content })),
			}),
		});
		if (!res.ok) throw new Error(`LLM failed: ${res.status}`);
		const data = (await res.json()) as { choices: Array<{ message: { content?: string } }> };
		const text = data.choices[0]!.message.content ?? "";
		yield { text, calls: [] }; // real mode: single-shot answer (tools are the exercise)
		if (text) return;
	}
}

// ---------------------------------------------------------------------------
// Demo: main run, blocked call, fork, alternate path
// ---------------------------------------------------------------------------

async function main() {
	const sessionFile = join(WORKSPACE, "..", `mini-pi-s10-session-${Date.now()}.jsonl`);
	writeFileSync(sessionFile, "");
	console.log(`s10: mini-pi   (workspace: ${WORKSPACE})`);
	console.log(`session: ${sessionFile}\n`);

	const store = new SessionStore(sessionFile);
	store.append({ type: "user", text: "Survey the workspace and record findings." });

	// Main run: three tool turns, compaction fires, guardrail fires.
	const mainScript = [
		{ text: "Surveying.", calls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }] },
		{ text: "Reading the readme.", calls: [{ id: "c2", name: "read", arguments: { path: "readme.md" } }] },
		{ text: "Counting via the extension tool, then cleaning up dangerously.", calls: [
			{ id: "c3", name: "count_files", arguments: {} },
			{ id: "c4", name: "bash", arguments: { command: "rm -rf /" } },
		] },
		{ text: "Guardrail stopped the cleanup; survey complete.", calls: [] },
	];

	await runAgent(store, process.env.PI_API_KEY ? realSteps(process.argv[2] ?? "Survey the workspace.", store) : fauxSteps(mainScript));

	// Fork: go back to the first assistant turn, take another path.
	const firstAssistant = store.path().find((e) => e.payload.type === "assistant")!;
	store.branch(firstAssistant.id);
	store.append({ type: "user", text: "Actually, just count the files." });
	await runAgent(store, fauxSteps([{ text: "Using the extension tool directly.", calls: [{ id: "f1", name: "count_files", arguments: {} }] }, { text: "Done: counted.", calls: [] }]));

	console.log(`\n\x1b[1m--- session tree (one file, both branches) ---\x1b[0m`);
	console.log(store.renderTree());
	console.log(`\nmodel-visible context now (${store.toMessages().length} messages):`);
	for (const m of store.toMessages()) console.log(`  \x1b[2m${m.role}: ${m.content.slice(0, 60)}\x1b[0m`);
	console.log(`\nKernel: one loop + one registry + one tree + one compactor.`);
	console.log("Guardrail: extension. count_files: extension. Fork: a pointer move. Thin kernel, thick ecosystem.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
