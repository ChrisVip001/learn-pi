#!/usr/bin/env node
/**
 * s02_event_stream.ts - The Loop Is an Event Stream
 *
 * s01's loop was a function: it runs, it returns. You cannot render progress,
 * log events, or attach a UI to it.
 *
 * pi's answer: the loop is an async generator that yields typed events.
 * The kernel does not print anything - it emits. Consumers decide what
 * events mean: a terminal renderer, a JSONL logger, a test harness...
 *
 *   agent_start
 *     turn_start
 *       message_start ─ message_update ─ ... ─ message_end
 *       tool_execution_start ─ tool_execution_end
 *     (loop while toolCalls present)
 *   agent_end  <- terminal event, carries the final message list
 *
 * Real pi: agentLoop(...) returns EventStream<AgentEvent, AgentMessage[]>
 * (packages/agent/src/agent-loop.ts); the event vocabulary lives in
 * packages/agent/src/types.ts.
 *
 * Usage: node s02_event_stream/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// -- message model (same as s01) --------------------------------------------

type TextBlock = { type: "text"; text: string };
type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type AssistantBlock = TextBlock | ToolCallBlock;
type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: AssistantBlock[] }
	| { role: "toolResult"; toolCallId: string; content: string };

// -- the event vocabulary ----------------------------------------------------

type AgentEvent =
	| { type: "agent_start"; task: string }
	| { type: "turn_start"; turn: number }
	| { type: "message_start" }
	| { type: "message_update"; delta: string }
	| { type: "message_end"; content: AssistantBlock[] }
	| { type: "tool_execution_start"; toolCallId: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_execution_end"; toolCallId: string; output: string }
	| { type: "agent_end"; messageCount: number };

// -- streaming faux provider: yields text chunks, then the final message -----

type StreamEvent = { type: "text_delta"; text: string } | { type: "message_end"; content: AssistantBlock[] };

const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-pi-s02-"));
writeFileSync(join(WORKSPACE, "notes.txt"), "pi teaches: thin kernel, thick ecosystem.\nextension events drive everything.\n");

const script: Array<{ chunks: string[]; calls?: Array<[string, Record<string, unknown>]> }> = [
	{
		chunks: ["I'll read ", "the notes ", "first."],
		calls: [["bash", { command: "cat notes.txt" }]],
	},
	{
		chunks: ["The notes say pi = thin kernel + thick ecosystem, ", "and events drive everything. ", "Summary complete."],
	},
];

async function* fauxStream(turn: number): AsyncGenerator<StreamEvent> {
	const step = script[Math.min(turn, script.length - 1)];
	for (const chunk of step.chunks) yield { type: "text_delta", text: chunk };
	const content: AssistantBlock[] = [{ type: "text", text: step.chunks.join("") }];
	for (const [name, args] of step.calls ?? []) {
		content.push({ type: "toolCall", id: `call_${turn + 1}`, name, arguments: args });
	}
	yield { type: "message_end", content };
}

// -- tool handler ------------------------------------------------------------

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => string> = {
	bash: (args) => {
		const r = spawnSync(String(args["command"] ?? ""), { shell: true, cwd: WORKSPACE, encoding: "utf8", timeout: 30_000 });
		return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 10_000) || "(no output)";
	},
};

// -- the kernel: a loop that *emits* instead of printing ----------------------

async function* agentLoop(messages: Message[]): AsyncGenerator<AgentEvent> {
	yield { type: "agent_start", task: (messages.at(-1)?.role === "user" ? messages.at(-1) : { content: "" }).content };
	let turn = 0;
	while (true) {
		yield { type: "turn_start", turn: ++turn };
		yield { type: "message_start" };

		const content: AssistantBlock[] = [];
		for await (const ev of fauxStream(turn - 1)) {
			if (ev.type === "text_delta") {
				yield { type: "message_update", delta: ev.text }; // stream through
				const text = content.find((b): b is TextBlock => b.type === "text");
				if (text) text.text += ev.text;
				else content.push({ type: "text", text: ev.text });
			} else {
				content.push(...ev.content.filter((b) => b.type === "toolCall"));
			}
		}
		yield { type: "message_end", content };
		messages.push({ role: "assistant", content });

		const toolCalls = content.filter((b): b is ToolCallBlock => b.type === "toolCall");
		if (toolCalls.length === 0) break;

		for (const call of toolCalls) {
			yield { type: "tool_execution_start", toolCallId: call.id, name: call.name, arguments: call.arguments };
			const output = TOOL_HANDLERS[call.name](call.arguments);
			yield { type: "tool_execution_end", toolCallId: call.id, output };
			messages.push({ role: "toolResult", toolCallId: call.id, content: output });
		}
	}
	yield { type: "agent_end", messageCount: messages.length };
}

// -- consumer 1: a terminal renderer -----------------------------------------

function render(ev: AgentEvent): void {
	switch (ev.type) {
		case "agent_start":
			console.log(`\x1b[1m▶ agent_start\x1b[0m  task: "${ev.task}"`);
			break;
		case "turn_start":
			console.log(`\x1b[2m── turn ${ev.turn} ──\x1b[0m`);
			break;
		case "message_start":
			process.stdout.write("  \x1b[36massistant: \x1b[0m");
			break;
		case "message_update":
			process.stdout.write(ev.delta);
			break;
		case "message_end":
			process.stdout.write("\n");
			break;
		case "tool_execution_start":
			console.log(`  \x1b[33m⚡ ${ev.name} ${JSON.stringify(ev.arguments)}\x1b[0m`);
			break;
		case "tool_execution_end":
			console.log(`  \x1b[2m${ev.output.slice(0, 120)}\x1b[0m`);
			break;
		case "agent_end":
			console.log(`\x1b[1m■ agent_end\x1b[0m  history: ${ev.messageCount} messages\n`);
			break;
	}
}

// -- consumer 2: a JSONL event logger ----------------------------------------

const EVENT_LOG = join(WORKSPACE, "events.jsonl");
function logEvent(ev: AgentEvent): void {
	appendFileSync(EVENT_LOG, `${JSON.stringify(ev)}\n`);
}

// -- entry point: one stream, many consumers ----------------------------------

async function main() {
	console.log(`s02: Event Stream   (event log: ${EVENT_LOG})\n`);
	const messages: Message[] = [
		{ role: "system", content: "You are a coding agent. Use bash." },
		{ role: "user", content: "Read notes.txt and summarize it." },
	];
	for await (const ev of agentLoop(messages)) {
		render(ev);
		logEvent(ev);
	}
	console.log("Two consumers saw the same stream: a renderer and a logger.");
	console.log("The kernel emitted. It printed nothing. It wrote nothing.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
