#!/usr/bin/env node
/**
 * s09_compaction.ts - Never Cut Between a Call and Its Result
 *
 * Context windows fill up. pi's compaction (coding-agent/src/core/
 * compaction/compaction.ts, ~30KB) works like this:
 *
 *   trigger   contextTokens > contextWindow - reserveTokens
 *             (checked after each tool batch, before each user prompt,
 *              and after each agent run; /compact forces it manually)
 *
 *   1. walk BACKWARDS from the newest entry, accumulating token estimates,
 *      until keepRecentTokens is covered            -> provisional cut
 *   2. adjust the cut to a LEGAL boundary:
 *        never cut so that a toolResult is separated from the assistant
 *        message that requested it (orphaned results corrupt the request)
 *   3. summarize everything BEFORE the cut into one compact message
 *   4. new context = system + summary + kept entries
 *        (the session LOG is untouched - only the request projection shrinks)
 *
 * Usage: node s09_compaction/code.ts   (offline, deterministic)
 */

// ---------------------------------------------------------------------------
// 1. Session entries + token estimation (chars/4 - crude but cheap)
// ---------------------------------------------------------------------------

type Entry =
	| { type: "user"; text: string }
	| { type: "assistant"; text: string; toolCallId?: string }
	| { type: "toolResult"; toolCallId: string; content: string };

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function entryTokens(e: Entry): number {
	if (e.type === "toolResult") return estimateTokens(e.content);
	return estimateTokens(e.text) + (e.toolCallId ? 10 : 0);
}

// ---------------------------------------------------------------------------
// 2. The compaction algorithm
// ---------------------------------------------------------------------------

interface CompactionConfig {
	contextWindow: number;
	reserveTokens: number;
	keepRecentTokens: number;
}

/** pi: _checkCompaction() - called after tool batches, before prompts, after runs. */
function needsCompaction(entries: Entry[], cfg: CompactionConfig): boolean {
	const total = entries.reduce((sum, e) => sum + entryTokens(e), 0);
	return total > cfg.contextWindow - cfg.reserveTokens;
}

/** A faux summarizer - real pi asks the model with a structured prompt. */
function summarize(older: Entry[]): string {
	const userQuestions = older.filter((e) => e.type === "user").map((e) => `"${(e as { text: string }).text.slice(0, 40)}"`);
	const toolRuns = older.filter((e) => e.type === "toolResult").length;
	const outputs = older
		.filter((e) => e.type === "toolResult")
		.map((e) => (e as { content: string }).content.split("\n")[0]?.slice(0, 50))
		.filter(Boolean);
	return [
		`[compacted summary of ${older.length} earlier messages]`,
		`user asked about: ${userQuestions.join(", ") || "(nothing)"}`,
		`tools ran ${toolRuns} time(s); first outputs: ${outputs.join(" | ") || "none"}`,
	].join("\n");
}

function compact(entries: Entry[], cfg: CompactionConfig): { context: Entry[]; summary: string; keptFrom: number } {
	// 1. Walk backwards until the recent budget is covered.
	let keptTokens = 0;
	let cut = entries.length;
	while (cut > 0 && keptTokens < cfg.keepRecentTokens) {
		cut--;
		keptTokens += entryTokens(entries[cut]!);
	}

	// 2. Adjust to a legal boundary: a toolResult must never be the first
	//    kept entry without the assistant call that requested it.
	while (cut < entries.length && entries[cut]!.type === "toolResult") {
		cut--; // pull the paired assistant call into the kept region
		keptTokens += entryTokens(entries[cut]!);
	}
	if (cut < 0) cut = 0;

	// 3. Summarize the older region.
	const older = entries.slice(0, cut);
	const summary = older.length > 0 ? summarize(older) : "";

	// 4. The request projection shrinks; the log stays append-only.
	const context: Entry[] = [{ type: "user", text: summary }, ...entries.slice(cut)];
	return { context, summary, keptFrom: cut };
}

// ---------------------------------------------------------------------------
// 3. Demo: a session that outgrows a (deliberately tiny) window
// ---------------------------------------------------------------------------

const CONFIG: CompactionConfig = {
	contextWindow: 900, // tiny on purpose - compaction triggers fast
	reserveTokens: 150,
	keepRecentTokens: 250,
};

const BIG_OUTPUT = `file1.ts: export const alpha = 1\nfile2.ts: export const beta = 2\n`.repeat(24);

const session: Entry[] = [
	{ type: "user", text: "Audit the repository layout and check the build." },
	{ type: "assistant", text: "Listing the files.", toolCallId: "c1" },
	{ type: "toolResult", toolCallId: "c1", content: BIG_OUTPUT },
	{ type: "assistant", text: "Many files. Checking the build now.", toolCallId: "c2" },
	{ type: "toolResult", toolCallId: "c2", content: BIG_OUTPUT },
	{ type: "assistant", text: "Build is green. Summarizing the layout.", toolCallId: "c3" },
	{ type: "toolResult", toolCallId: "c3", content: BIG_OUTPUT },
	{ type: "user", text: "Good. Now write the audit report." },
];

function totalTokens(entries: Entry[]): number {
	return entries.reduce((sum, e) => sum + entryTokens(e), 0);
}

function describe(entries: Entry[]): string {
	return entries.map((e) => `${e.type}${"toolCallId" in e ? `(${e.toolCallId})` : ""}`).join(" ");
}

function main() {
	console.log("s09: Compaction\n");
	console.log(`config: window=${CONFIG.contextWindow} reserve=${CONFIG.reserveTokens} keepRecent=${CONFIG.keepRecentTokens} tokens`);
	console.log(`session: ${describe(session)}`);
	console.log(`total: ${totalTokens(session)} tokens`);

	if (!needsCompaction(session, CONFIG)) {
		console.log("no compaction needed");
		return;
	}

	console.log("\n\u2588 trigger: total > window - reserve\n");

	const { context, summary, keptFrom } = compact(session, CONFIG);

	console.log(`cut at index ${keptFrom} - older region (${keptFrom} entries) -> summarized:`);
	console.log(`  \x1b[35m${summary.split("\n").join("\n  ")}\x1b[0m`);

	console.log(`\nkept region (${session.length - keptFrom} entries): ${describe(session.slice(keptFrom))}`);
	console.log("\x1b[2m(note: the assistant call c3 and its toolResult crossed the provisional cut - the boundary was moved back so they stay together)\x1b[0m");

	console.log(`\nnew request context: ${describe(context)}`);
	console.log(`tokens: ${totalTokens(session)} -> ${totalTokens(context)} (log unchanged: ${session.length} entries stay on disk)`);

	// Trigger points, manual override, extension takeover - the real product:
	console.log("\nreal pi:");
	console.log("  triggers: after tool batches, before user prompts, after agent runs");
	console.log("  manual: /compact [instructions]");
	console.log("  extensions can fully take over: session_before_compact event");
	console.log("  split turns (one huge turn) get TWO summaries: history + turn prefix");
}

main();
