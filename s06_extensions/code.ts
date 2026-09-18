#!/usr/bin/env node
/**
 * s06_extensions.ts - The Kernel Hosts; Extensions Act
 *
 * Everything pi refuses to hard-code is an extension. The kernel exposes an
 * ExtensionAPI; extensions consume typed events and contribute capabilities:
 *
 *   pi.on("tool_call", handler)          -> may return { block, reason }
 *   pi.on("before_provider_request", h)  -> may mutate the outgoing payload
 *   pi.registerTool(...)                 -> new tool joins the registry
 *   pi.registerCommand(...)              -> new slash command
 *
 * (The real contract: pi/packages/coding-agent/src/core/extensions/types.ts,
 * ~1800 lines, ~40 event types. Loaded by extensions/loader.ts via jiti.)
 *
 * This chapter builds a mini runner + loader. The loader follows pi's real
 * directory convention - extensions ship in `.pi/extensions/` inside a project -
 * and dynamically imports them (.mjs here so we stay dependency-free; pi
 * uses jiti to import TypeScript directly).
 *
 * Usage: node s06_extensions/code.ts   (offline, deterministic)
 */

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 1. The event vocabulary + the ExtensionAPI surface (a focused subset)
// ---------------------------------------------------------------------------

type ExtensionEvent =
	| { type: "session_start"; cwd: string }
	| { type: "before_provider_request"; request: { model: string; messages: unknown[] } }
	| { type: "tool_call"; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; name: string; output: string }
	| { type: "session_end" };

type BlockDecision = { block: true; reason: string };

type AnyHandler = (ev: ExtensionEvent) => void | BlockDecision;

interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>) => string;
}

interface ExtensionApi {
	on<E extends ExtensionEvent["type"]>(type: E, handler: (ev: Extract<ExtensionEvent, { type: E }>) => void | BlockDecision): void;
	registerTool(tool: ToolDefinition): void;
	registerCommand(name: string, run: () => void): void;
	log(message: string): void;
}

type ExtensionFactory = (pi: ExtensionApi) => void;

// ---------------------------------------------------------------------------
// 2. The runner: dispatches events, aggregates blocks, collects contributions
// ---------------------------------------------------------------------------

class ExtensionRunner {
	private handlers = new Map<string, AnyHandler[]>();
	private sources = new Map<AnyHandler, string>();
	readonly tools = new Map<string, ToolDefinition>();
	readonly commands = new Map<string, () => void>();

	load(name: string, factory: ExtensionFactory): void {
		const api: ExtensionApi = {
			on: (type, handler) => {
				const list = this.handlers.get(type) ?? [];
				list.push(handler as AnyHandler);
				this.handlers.set(type, list);
				this.sources.set(handler as AnyHandler, name);
			},
			registerTool: (tool) => {
				this.tools.set(tool.name, tool);
				console.log(`\x1b[35m[ext:${name}] registered tool '${tool.name}'\x1b[0m`);
			},
			registerCommand: (cmd, run) => this.commands.set(cmd, run),
			log: (message) => console.log(`\x1b[35m[ext:${name}] ${message}\x1b[0m`),
		};
		factory(api);
	}

	/** Dispatch an event; return the first block decision, if any. */
	dispatch<E extends ExtensionEvent>(ev: E): BlockDecision | undefined {
		for (const handler of this.handlers.get(ev.type) ?? []) {
			const result = handler(ev);
			if (result && result.block) return { ...result, reason: `[${this.sources.get(handler)}] ${result.reason}` };
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// 3. The loader: discover extensions from .pi/extensions/ (pi's convention)
//    Real pi: extensions/loader.ts, using jiti so extensions can be plain TS.
// ---------------------------------------------------------------------------

async function loadExtensionsFromDirectory(dir: string, runner: ExtensionRunner): Promise<void> {
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
		const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default: ExtensionFactory };
		runner.load(file.replace(/\.mjs$/, ""), mod.default);
	}
}

// ---------------------------------------------------------------------------
// 4. A project extension, written to disk exactly like a real one
// ---------------------------------------------------------------------------

const PROJECT = mkdtempSync(join(tmpdir(), "mini-pi-s06-"));
const EXT_DIR = join(PROJECT, ".pi", "extensions");
mkdirSync(EXT_DIR, { recursive: true });

writeFileSync(
	join(EXT_DIR, "weather.mjs"),
	`export default function (pi) {
  pi.log("weather extension loaded");
  pi.registerTool({
    name: "weather",
    description: "Get the current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    execute: (args) => "Weather in " + args.city + ": sunny, 24C",
  });
  pi.on("tool_call", (ev) => {
    if (ev.name === "weather" && !ev.arguments.city) {
      return { block: true, reason: "city is required" };
    }
  });
};
`,
);

// ---------------------------------------------------------------------------
// 5. An inline extension: guardrails (blocks destructive bash) + redaction
// ---------------------------------------------------------------------------

const guardrails: ExtensionFactory = (pi) => {
	pi.log("guardrails loaded - blocking destructive commands");
	pi.on("tool_call", (ev) => {
		if (ev.name === "bash" && String(ev.arguments["command"] ?? "").includes("rm -rf")) {
			return { block: true, reason: "destructive command blocked" };
		}
	});
};

const redactor: ExtensionFactory = (pi) => {
	pi.on("before_provider_request", (ev) => {
		// Mutate the outgoing payload in place - secrets never reach the wire.
		for (const m of ev.request.messages) {
			if (m && typeof m === "object" && "content" in m && typeof m.content === "string") {
				(m as { content: string }).content = m.content.replace(/secret-\\w+/g, "[REDACTED]");
			}
		}
	});
};

// ---------------------------------------------------------------------------
// 6. Scripted mini-loop: extension tool, blocked call, redaction proof
// ---------------------------------------------------------------------------

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
const script: Array<{ text: string; calls: ToolCall[] }> = [
	{ text: "Checking the weather.", calls: [{ id: "c1", name: "weather", arguments: { city: "Hangzhou" } }] },
	{ text: "Now cleaning up (dangerously).", calls: [{ id: "c2", name: "bash", arguments: { command: "rm -rf /tmp/important" } }] },
	{ text: "Understood - I will avoid rm -rf. Task complete.", calls: [] },
];

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => string> = {
	bash: () => "(this would have run)",
};

async function main() {
	console.log(`s06: Extensions   (project: ${PROJECT})\n`);
	const runner = new ExtensionRunner();
	await loadExtensionsFromDirectory(EXT_DIR, runner); // discovered from disk
	runner.load("guardrails", guardrails); // registered programmatically
	runner.load("redactor", redactor);

	runner.dispatch({ type: "session_start", cwd: PROJECT });

	const messages: Array<{ role: string; content: string; toolCallId?: string }> = [
		{ role: "user", content: "Check the weather, then clean up. My token is secret-abc123." },
	];

	for (let turn = 0; turn < script.length; turn++) {
		const step = script[turn]!;
		// Every outgoing request passes through before_provider_request first.
		const request = { model: "faux", messages: [...messages] };
		runner.dispatch({ type: "before_provider_request", request });
		if (turn === 0) console.log(`\n\x1b[2moutgoing request[0]: "${(request.messages[0] as { content: string }).content}"\x1b[0m`);

		if (step.calls.length === 0) break;
		for (const call of step.calls) {
			console.log(`\x1b[33m⚡ ${call.name} ${JSON.stringify(call.arguments)}\x1b[0m`);
			const blocked = runner.dispatch({ type: "tool_call", name: call.name, arguments: call.arguments });
			let output: string;
			if (blocked) {
				console.log(`  \x1b[31m✗ blocked: ${blocked.reason}\x1b[0m`);
				output = `Error: blocked by extension: ${blocked.reason}`;
			} else {
				const tool = runner.tools.get(call.name);
				output = tool ? tool.execute(call.arguments) : TOOL_HANDLERS[call.name](call.arguments);
				console.log(`  \x1b[2m${output}\x1b[0m`);
			}
			runner.dispatch({ type: "tool_result", name: call.name, output });
			messages.push({ role: "toolResult", content: output, toolCallId: call.id });
		}
	}

	runner.dispatch({ type: "session_end" });
	console.log(`\nRegistered commands: ${[...runner.commands.keys()].length} (none here - registerCommand works the same way)`);
	console.log("The kernel shipped none of this: weather came from disk, blocking and redaction from inline extensions.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
