#!/usr/bin/env node
/**
 * s04_tool_results.ts - Two Channels, Three Defenses
 *
 * A tool result in pi is NOT a string. It is:
 *
 *   AgentToolResult<TDetails> = {
 *     content:  blocks[]        <- what the MODEL sees (text, images)
 *     details?: TDetails        <- what the UI sees (typed, structured)
 *     terminate?: boolean       <- this tool result can end the whole agent
 *   }
 *
 * (pi/packages/agent/src/types.ts - the dual channel keeps prompts lean
 * while the TUI renders rich structured data.)
 *
 * Plus three kernel defenses this chapter builds:
 *
 *   1. onUpdate  - tools stream partial results (a long bash shows progress)
 *   2. terminate - a tool result can stop the agent loop
 *   3. failToolCallsFromTruncatedMessage - if the model's message hit the
 *      token limit mid-tool-call (stopReason "length"), the kernel does NOT
 *      trust the possibly-corrupt calls: it fails them with a synthetic
 *      toolResult and lets the model re-send.
 *      (pi/packages/agent/src/agent-loop.ts:434)
 *
 * Usage: node s04_tool_results/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-pi-s04-"));
writeFileSync(join(WORKSPACE, "config.txt"), "theme=dark\nfont=mono\nvim_mode=off\n");

// ---------------------------------------------------------------------------
// 1. The dual-channel result type
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };
type AgentToolResult<TDetails = unknown> = {
	content: TextBlock[];
	details?: TDetails;
	terminate?: boolean;
};

interface EditDetails {
	path: string;
	linesChanged: number;
	diff: string;
}

// ---------------------------------------------------------------------------
// 2. Tools: edit returns details; bash streams via onUpdate; task_complete terminates
// ---------------------------------------------------------------------------

type OnUpdate = (partial: string) => void;

async function editTool(path: string, newText: string): Promise<AgentToolResult<EditDetails>> {
	const oldText = readFileSync(join(WORKSPACE, path), "utf8");
	writeFileSync(join(WORKSPACE, path), newText);
	const oldLines = oldText.split("\n").length;
	const newLines = newText.split("\n").length;
	return {
		content: [{ type: "text", text: `Edited ${path} (${newLines - oldLines >= 0 ? "+" : ""}${newLines - oldLines} lines).` }],
		details: { path, linesChanged: newLines - oldLines, diff: `- ${oldText.trim().split("\n").join("\n- ")}\n+ ${newText.trim().split("\n").join("\n+ ")}` },
	};
}

async function bashTool(command: string, onUpdate: OnUpdate): Promise<AgentToolResult> {
	// Simulate a long-running command producing output over time.
	let final = "";
	for (const line of [`building ${command}...`, "step 1/3 done", "step 2/3 done", "step 3/3 done", "all green"]) {
		await sleep(60);
		final += `${line}\n`;
		onUpdate(final.trim()); // partial result -> UI channel only
	}
	return { content: [{ type: "text", text: final.trim() }] }; // model sees the final output
}

async function taskCompleteTool(summary: string): Promise<AgentToolResult> {
	return {
		content: [{ type: "text", text: summary }],
		terminate: true, // this result ends the agent
	};
}

// ---------------------------------------------------------------------------
// 3. The truncated-message defense
//    (pi: failToolCallsFromTruncatedMessage - agent-loop.ts:434)
// ---------------------------------------------------------------------------

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: Array<TextBlock | ToolCall & { type: "toolCall" }> }
	| { role: "toolResult"; toolCallId: string; content: string };

function failToolCallsFromTruncatedMessage(calls: ToolCall[], messages: Message[]): void {
	// A message that hit the token limit may contain HALF-WRITTEN tool calls.
	// Executing them would run a corrupted command. Instead: fail them all,
	// tell the model why, and let it re-issue the batch.
	for (const call of calls) {
		messages.push({
			role: "toolResult",
			toolCallId: call.id,
			content: "Error: your message was truncated before this tool call completed. Please re-send the tool call with fewer tokens.",
		});
	}
	console.log(`  \x1b[31m⚠ stopReason=length - ${calls.length} tool call(s) failed as truncated, model will re-send\x1b[0m`);
}

// ---------------------------------------------------------------------------
// 4. The scripted model: one truncation, one terminate
// ---------------------------------------------------------------------------

let turn = 0;
const script: Array<{ content: Array<TextBlock | (ToolCall & { type: "toolCall" })>; stopReason: "end_turn" | "tool_use" | "length" }> = [
	{
		content: [
			{ type: "text", text: "Turning on vim mode in the config." },
			{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "config.txt", newText: "theme=dark\nfont=mono\nvim_mode=on\n" } },
		],
		stopReason: "tool_use",
	},
	{
		// Truncated mid-call: arguments are half-written JSON - DO NOT execute.
		content: [
			{ type: "text", text: "Now verifying the config and running the test suite, plus a very long explanation that pushes the message past the output token limit so it gets cut of" },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "cat config.txt && npm te" } },
		],
		stopReason: "length",
	},
	{
		content: [
			{ type: "text", text: "Re-sending the batch, more compactly." },
			{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat config.txt && npm test" } },
		],
		stopReason: "tool_use",
	},
	{
		content: [
			{ type: "text", text: "Config verified, tests green." },
			{ type: "toolCall", id: "c4", name: "task_complete", arguments: { summary: "Enabled vim_mode and verified the test suite." } },
		],
		stopReason: "tool_use",
	},
];

const nextResponse = () => script[Math.min(turn++, script.length - 1)]!;

// ---------------------------------------------------------------------------
// 5. The kernel loop with all defenses wired in
// ---------------------------------------------------------------------------

async function agentLoop(messages: Message[]): Promise<void> {
	while (true) {
		const response = nextResponse();
		messages.push({ role: "assistant", content: response.content });
		const toolCalls = response.content.filter((b): b is ToolCall & { type: "toolCall" } => b.type === "toolCall");

		if (response.stopReason === "length" && toolCalls.length > 0) {
			failToolCallsFromTruncatedMessage(toolCalls, messages); // defense 3
			continue; // model gets the failures and re-sends
		}
		if (toolCalls.length === 0) return;

		for (const call of toolCalls) {
			console.log(`\x1b[33m⚡ ${call.name} ${JSON.stringify(call.arguments).slice(0, 90)}\x1b[0m`);
			let result: AgentToolResult;
			if (call.name === "edit") {
				result = await editTool(String(call.arguments["path"]), String(call.arguments["newText"]));
			} else if (call.name === "bash") {
				result = await bashTool(String(call.arguments["command"]), (partial) => {
					process.stdout.write(`  \x1b[2m… ${partial.split("\n").at(-1)}\x1b[0m\r`); // defense 1: streaming UI
				});
				process.stdout.write("\n");
			} else if (call.name === "task_complete") {
				result = await taskCompleteTool(String(call.arguments["summary"] ?? ""));
			} else {
				result = { content: [{ type: "text", text: `Error: unknown tool '${call.name}'` }] };
			}

			// UI channel: rich, structured, never sent to the model.
			if (result.details) {
				const d = result.details as EditDetails;
				console.log(`  \x1b[32m${d.diff.split("\n").join("\n\x1b[32m  ")}\x1b[0m`);
			}
			// Model channel: plain text blocks.
			messages.push({ role: "toolResult", toolCallId: call.id, content: result.content.map((b) => b.text).join("\n") });
			if (result.terminate) {
				console.log(`\x1b[1m■ terminate - tool result ended the agent\x1b[0m`);
				return; // defense 2
			}
		}
	}
}

async function main() {
	console.log(`s04: Tool Result Channels   (workspace: ${WORKSPACE})\n`);
	const messages: Message[] = [
		{ role: "system", content: "You are a coding agent." },
		{ role: "user", content: "Enable vim mode in config.txt, verify, then finish." },
	];
	await agentLoop(messages);

	console.log("\n--- model-visible history (content channel only) ---");
	for (const m of messages) {
		if (m.role === "toolResult") console.log(`  \x1b[2m[${m.toolCallId}] ${m.content.slice(0, 70)}\x1b[0m`);
	}
	console.log(`\n(${messages.length} messages - the colored diff never entered the model's context)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
