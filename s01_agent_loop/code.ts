#!/usr/bin/env node
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire kernel of a coding agent in one pattern, pi-style:
 *
 *   1. a unified message model (system / user / assistant / toolResult)
 *   2. an LLM call that returns content blocks (text | toolCall)
 *   3. a while loop: toolCall blocks present -> execute -> feed back -> repeat
 *      no toolCall blocks -> stop
 *
 *    +--------+      +---------+      +------------+
 *    |  user  | ---> |   LLM   | ---> |  toolCall  |
 *    | prompt |      | blocks  |      |  execute   |
 *    +--------+      +----+----+      +------+-----+
 *                        ^                  |
 *                        |   toolResult     |
 *                        +------------------+
 *                        (loop continues)
 *
 * Two interchangeable LLM backends:
 *   - FauxProvider (default): fully scripted, offline, deterministic - the
 *     same trick pi uses in packages/ai/src/providers/faux.ts
 *   - any OpenAI-compatible endpoint via env: PI_API_KEY / PI_BASE_URL / PI_MODEL
 *
 * Usage:
 *   node s01_agent_loop/code.ts            # offline faux mode
 *   PI_API_KEY=sk-... node s01_agent_loop/code.ts "your task"
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 1. Unified message model (a miniature of pi-ai's message vocabulary)
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };
type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};
type AssistantBlock = TextBlock | ToolCallBlock;

type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: AssistantBlock[] }
	| { role: "toolResult"; toolCallId: string; content: string };

interface LlmResponse {
	content: AssistantBlock[];
	stopReason: "end_turn" | "tool_use" | "length";
}

type Llm = (messages: Message[], tools: ToolSchema[]) => Promise<LlmResponse>;

// ---------------------------------------------------------------------------
// 2. Tools: a schema for the model + a handler for the kernel
// ---------------------------------------------------------------------------

interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

// The demo runs inside a throwaway directory - never in your project.
const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-pi-s01-"));
writeFileSync(join(WORKSPACE, "notes.txt"), "pi = thin kernel + thick ecosystem\n");
writeFileSync(join(WORKSPACE, "todo.txt"), "finish chapter s01\n");

function runBash(command: string): string {
	if (DANGEROUS.some((d) => command.includes(d))) {
		return "Error: Dangerous command blocked";
	}
	const r = spawnSync(command, {
		shell: true,
		cwd: WORKSPACE,
		timeout: 30_000,
		encoding: "utf8",
	});
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	return out.slice(0, 20_000) || "(no output)";
}

const TOOLS: ToolSchema[] = [
	{
		name: "bash",
		description: "Run a shell command in the workspace.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
];

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => string> = {
	bash: (args) => runBash(String(args["command"] ?? "")),
};

// ---------------------------------------------------------------------------
// 3. FauxProvider: a scripted, offline, deterministic LLM
//    (pi ships the same idea at 20x scale in ai/src/providers/faux.ts)
// ---------------------------------------------------------------------------

let callCount = 0;
const fauxScript: Array<{ text?: string; calls?: Array<[string, Record<string, unknown>]> }> = [
	{ text: "Let me look at the workspace first.", calls: [["bash", { command: "ls" }]] },
	{
		text: "Two text files. I will create the summary and verify it.",
		calls: [["bash", { command: "echo '2 txt files before me' > summary.txt && ls" }]],
	},
	{ text: "Done. The workspace had notes.txt and todo.txt; I created summary.txt describing both." },
];

const fauxLlm: Llm = async () => {
	const step = fauxScript[Math.min(callCount++, fauxScript.length - 1)];
	const content: AssistantBlock[] = [];
	if (step.text) content.push({ type: "text", text: step.text });
	for (const [name, args] of step.calls ?? []) {
		content.push({ type: "toolCall", id: `call_${callCount}`, name, arguments: args });
	}
	return { content, stopReason: step.calls ? "tool_use" : "end_turn" };
};

// ---------------------------------------------------------------------------
// 4. Real LLM (optional): any OpenAI-compatible endpoint, via plain fetch
// ---------------------------------------------------------------------------

async function realLlm(messages: Message[], tools: ToolSchema[]): Promise<LlmResponse> {
	const base = process.env.PI_BASE_URL ?? "https://api.deepseek.com";
	const wireMessages = messages.map((m) => {
		if (m.role === "system") return { role: "system", content: m.content };
		if (m.role === "user") return { role: "user", content: m.content };
		if (m.role === "toolResult") {
			return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
		}
		return {
			role: "assistant",
			content: m.content
				.filter((b): b is TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("\n"),
			tool_calls: m.content
				.filter((b): b is ToolCallBlock => b.type === "toolCall")
				.map((b) => ({
					id: b.id,
					type: "function",
					function: { name: b.name, arguments: JSON.stringify(b.arguments) },
				})),
		};
	});
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.PI_API_KEY}`,
		},
		body: JSON.stringify({
			model: process.env.PI_MODEL ?? "deepseek-chat",
			messages: wireMessages,
			tools: tools.map((t) => ({
				type: "function",
				function: { name: t.name, description: t.description, parameters: t.parameters },
			})),
		}),
	});
	if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as {
		choices: Array<{
			finish_reason: string;
			message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
		}>;
	};
	const choice = data.choices[0];
	const content: AssistantBlock[] = [];
	if (choice.message.content) content.push({ type: "text", text: choice.message.content });
	for (const tc of choice.message.tool_calls ?? []) {
		content.push({
			type: "toolCall",
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
		});
	}
	const stopReason = choice.finish_reason === "length" ? "length" : choice.message.tool_calls?.length ? "tool_use" : "end_turn";
	return { content, stopReason };
}

// ---------------------------------------------------------------------------
// 5. The kernel: the loop itself
// ---------------------------------------------------------------------------

async function agentLoop(messages: Message[], llm: Llm): Promise<void> {
	while (true) {
		const response = await llm(messages, TOOLS);
		messages.push({ role: "assistant", content: response.content });

		const toolCalls = response.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
		if (toolCalls.length === 0) return; // model chose to stop

		for (const call of toolCalls) {
			const handler = TOOL_HANDLERS[call.name];
			if (!handler) {
				messages.push({ role: "toolResult", toolCallId: call.id, content: `Error: unknown tool '${call.name}'` });
				continue;
			}
			console.log(`\x1b[33m$ ${String(call.arguments["command"] ?? call.name)}\x1b[0m`);
			const output = handler(call.arguments);
			console.log(`\x1b[2m${output.slice(0, 200)}\x1b[0m`);
			messages.push({ role: "toolResult", toolCallId: call.id, content: output });
		}
	}
}

// ---------------------------------------------------------------------------
// 6. Entry point
// ---------------------------------------------------------------------------

async function main() {
	const useReal = Boolean(process.env.PI_API_KEY);
	const task =
		process.argv[2] ?? "How many text files are in the workspace? Create summary.txt describing them.";

	console.log(`s01: Agent Loop  (${useReal ? "real model" : "FauxProvider - offline, deterministic"})`);
	console.log(`workspace: ${WORKSPACE}\n`);

	const messages: Message[] = [
		{ role: "system", content: `You are a coding agent working in ${WORKSPACE}. Use bash. Act, don't explain.` },
		{ role: "user", content: task },
	];

	await agentLoop(messages, useReal ? realLlm : fauxLlm);

	const last = messages[messages.length - 1];
	if (last.role === "assistant") {
		for (const block of last.content) {
			if (block.type === "text") console.log(`\n\x1b[36m${block.text}\x1b[0m`);
		}
	}
	console.log(`\n(${messages.length} messages in history)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
