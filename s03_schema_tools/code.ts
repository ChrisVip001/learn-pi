#!/usr/bin/env node
/**
 * s03_schema_tools.ts - A Tool Is a Schema Plus a Handler
 *
 * s01/s02 dispatched tools through a raw map of (args) => string. Problems:
 *   - model arguments arrive unvalidated (a missing "path" crashes the handler)
 *   - no way to declare which tools are safe to run concurrently
 *   - no way for the model to learn that the tool set CHANGED mid-session
 *
 * pi's answer (TypeBox + AgentTool in packages/agent/src/types.ts):
 *   1. schema-first: parameters declared as a composable schema,
 *      TypeScript types inferred FROM the schema (type Infer<S> below)
 *   2. every tool declares executionMode: "sequential" | "parallel"
 *   3. schema is validated BEFORE the handler runs; bad args become a
 *      normal error toolResult - the turn continues, nothing crashes
 *   4. when the tool set changes, the change is DECLARED INTO the session
 *      history as its own message (declareToolChanges in agent-loop.ts) -
 *      the model is told, replay stays faithful
 *
 * Usage: node s03_schema_tools/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 1. A 40-line TypeBox: composable schemas + type inference + validation
// ---------------------------------------------------------------------------

type Schema =
	| { type: "string" }
	| { type: "number" }
	| { type: "boolean" }
	| { type: "object"; properties: Record<string, Schema>; required: string[] };

const T = {
	string: (): Schema => ({ type: "string" }),
	number: (): Schema => ({ type: "number" }),
	boolean: (): Schema => ({ type: "boolean" }),
	object: (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
		type: "object",
		properties,
		required,
	}),
};

// Types inferred from the schema - the reason pi picked TypeBox over zod:
// the schema IS the type, no duplicate declarations.
type Infer<S extends Schema> =
	S extends { type: "string" } ? string
	: S extends { type: "number" } ? number
	: S extends { type: "boolean" } ? boolean
	: S extends { type: "object"; properties: infer P } ? { [K in keyof P]: Infer<P[K & keyof P]> }
	: never;

function validate(schema: Schema, value: unknown, path = "args"): string[] {
	switch (schema.type) {
		case "string":
			return typeof value === "string" ? [] : [`${path}: expected string, got ${typeof value}`];
		case "number":
			return typeof value === "number" ? [] : [`${path}: expected number, got ${typeof value}`];
		case "boolean":
			return typeof value === "boolean" ? [] : [`${path}: expected boolean, got ${typeof value}`];
		case "object": {
			if (typeof value !== "object" || value === null) return [`${path}: expected object`];
			const errors: string[] = [];
			const obj = value as Record<string, unknown>;
			for (const key of schema.required) {
				if (!(key in obj)) errors.push(`${path}.${key}: required but missing`);
			}
			for (const [key, sub] of Object.entries(schema.properties)) {
				if (key in obj) errors.push(...validate(sub, obj[key], `${path}.${key}`));
			}
			return errors;
		}
	}
}

// ---------------------------------------------------------------------------
// 2. AgentTool: schema + handler + execution mode + compat shim
// ---------------------------------------------------------------------------

interface AgentTool<S extends Schema = Schema> {
	name: string;
	description: string;
	parameters: S;
	executionMode: "sequential" | "parallel";
	/** Compatibility shim: repair arguments from models that don't follow the schema. */
	prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
	execute: (args: Infer<S>) => string;
}

const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-pi-s03-"));
writeFileSync(join(WORKSPACE, "notes.txt"), "thin kernel\n");
writeFileSync(join(WORKSPACE, "todo.txt"), "thick ecosystem\n");

const readTool: AgentTool<ReturnType<typeof T.object>> = {
	name: "read",
	description: "Read a file's content.",
	parameters: T.object({ path: T.string() }),
	executionMode: "parallel", // reading two files can never conflict
	execute: (args) => {
		try {
			return readFileSync(join(WORKSPACE, args.path), "utf8").slice(0, 5000);
		} catch {
			return `Error: cannot read '${args.path}'`;
		}
	},
};

const bashTool: AgentTool = {
	name: "bash",
	description: "Run a shell command.",
	parameters: T.object({ command: T.string() }),
	executionMode: "sequential", // shell side effects must not overlap
	// shim: tolerate a model that sends { cmd: "ls" } instead of { command: "ls" }
	prepareArguments: (args) => ("command" in args ? args : { command: args["cmd"] ?? "" }),
	execute: (args) => {
		const r = spawnSync(String(args["command"] ?? ""), { shell: true, cwd: WORKSPACE, encoding: "utf8", timeout: 30_000 });
		return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 5000) || "(no output)";
	},
};

const grepTool: AgentTool = {
	name: "grep",
	description: "Search file content for a pattern.",
	parameters: T.object({ pattern: T.string(), path: T.string() }),
	executionMode: "parallel",
	execute: (args) => {
		try {
			const lines = readFileSync(join(WORKSPACE, String(args["path"])), "utf8")
				.split("\n")
				.filter((l) => l.includes(String(args["pattern"] ?? "")));
			return lines.join("\n") || "(no matches)";
		} catch {
			return `Error: cannot read '${String(args["path"])}'`;
		}
	},
};

// ---------------------------------------------------------------------------
// 3. Registry + validated dispatch + ordered parallel/sequential batches
// ---------------------------------------------------------------------------

class ToolRegistry {
	private tools = new Map<string, AgentTool>();

	register(tool: AgentTool): void {
		this.tools.set(tool.name, tool);
	}

	schemasForModel(): Array<{ name: string; description: string; parameters: Schema }> {
		// Only schema data crosses the model boundary - never execute().
		return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
	}

	execute(call: { id: string; name: string; arguments: Record<string, unknown> }): string {
		const tool = this.tools.get(call.name);
		if (!tool) return `Error: unknown tool '${call.name}'`;
		const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const errors = validate(tool.parameters, args);
		if (errors.length > 0) return `Error: invalid arguments (${errors.join("; ")})`;
		return tool.execute(args as never);
	}

	/** Run one model-issued batch: parallel tools concurrently, sequential in order. */
	async executeBatch(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Promise<Array<{ id: string; output: string }>> {
		const outputs = new Map<string, string>();
		const parallel = calls.filter((c) => this.tools.get(c.name)?.executionMode === "parallel");
		const sequential = calls.filter((c) => this.tools.get(c.name)?.executionMode !== "parallel");

		// Promise.all runs them together; results land back in call order.
		await Promise.all(
			parallel.map(async (c) => {
				outputs.set(c.id, this.execute(c));
			}),
		);
		for (const c of sequential) outputs.set(c.id, this.execute(c));
		return calls.map((c) => ({ id: c.id, output: outputs.get(c.id) ?? "" }));
	}
}

// ---------------------------------------------------------------------------
// 4. Tool changes are DECLARED INTO session history (pi: declareToolChanges)
// ---------------------------------------------------------------------------

type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> }
	| { role: "toolResult"; toolCallId: string; content: string };

function declareToolChanges(active: Set<string>, registry: ToolRegistry, messages: Message[]): void {
	const current = new Set([...active]);
	const added = [...current].filter((n) => !active.has(n));
	const removed = [...active].filter((n) => !current.has(n));
	if (added.length === 0 && removed.length === 0) return;
	const parts: string[] = [];
	if (added.length) parts.push(`Tools added: ${added.join(", ")}`);
	if (removed.length) parts.push(`Tools removed: ${removed.join(", ")}`);
	messages.push({ role: "system", content: `[tool changes] ${parts.join(". ")}` });
	console.log(`\x1b[35m[history] ${parts.join(". ")}\x1b[0m`);
}

// ---------------------------------------------------------------------------
// 5. Scripted demo: a batch with mixed modes, an invalid call, a late install
// ---------------------------------------------------------------------------

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
const script: Array<{ text: string; calls: ToolCall[] }> = [
	{
		text: "Reading both files and listing the directory in one batch.",
		calls: [
			{ id: "c1", name: "read", arguments: { path: "notes.txt" } },
			{ id: "c2", name: "read", arguments: { path: "todo.txt" } },
			{ id: "c3", name: "bash", arguments: { cmd: "ls" } }, // shim kicks in: "cmd" -> "command"
			{ id: "c4", name: "grep", arguments: {} }, // not registered yet + invalid args
		],
	},
	{ text: "grep is available now - searching for the thesis.", calls: [{ id: "c5", name: "grep", arguments: { pattern: "kernel", path: "notes.txt" } }] },
	{ text: "notes.txt states the thesis: thin kernel, thick ecosystem.", calls: [] },
];

async function main() {
	console.log(`s03: Schema-First Tools   (workspace: ${WORKSPACE})\n`);
	const registry = new ToolRegistry();
	registry.register(readTool);
	registry.register(bashTool);
	const activeTools = new Set(["read", "bash"]);

	const messages: Message[] = [
		{ role: "system", content: "You are a coding agent." },
		{ role: "user", content: "Read the files, then find the thesis." },
	];

	for (let turn = 0; turn < script.length; turn++) {
		const step = script[turn]!;
		if (turn === 1) {
			// An extension just installed a new tool (s06/s07 make this real).
			registry.register(grepTool);
			activeTools.add("grep");
			declareToolChanges(activeTools, registry, messages);
		}
		const content = [
			{ type: "text", text: step.text } as const,
			...step.calls.map((c) => ({ type: "toolCall" as const, ...c })),
		];
		messages.push({ role: "assistant", content: [...content] });
		if (step.calls.length === 0) break;

		for (const c of step.calls) console.log(`\x1b[33m⚡ ${c.name} ${JSON.stringify(c.arguments)}\x1b[0m`);
		const results = await registry.executeBatch(step.calls);
		for (const r of results) {
			console.log(`  \x1b[2m${r.output.slice(0, 100)}\x1b[0m`);
			messages.push({ role: "toolResult", toolCallId: r.id, content: r.output });
		}
	}

	console.log("\n--- final history ---");
	for (const m of messages) {
		if (m.role === "system" && m.content.startsWith("[tool changes]")) {
			console.log(`\x1b[35m${m.content}\x1b[0m`);
		}
	}
	console.log(`(${messages.length} messages - the tool-change declaration is part of the replayable history)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
