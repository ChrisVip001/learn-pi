#!/usr/bin/env node
/**
 * s05_provider_matrix.ts - API x Provider, Orthogonally
 *
 * Supporting N providers x M wire protocols the naive way means N*M adapters.
 * pi supports 40+ providers with 10 protocol implementations by splitting the
 * problem orthogonally (pi/packages/ai/src/types.ts):
 *
 *   Api      = the WIRE PROTOCOL ("anthropic-messages", "openai-completions", ...)
 *              -> implements unified <-> wire translation, knows protocol quirks
 *   Provider = the VENDOR (baseUrl + auth + model catalog)
 *              -> picks an Api, supplies endpoints and keys
 *   Compat   = a typed matrix of boolean capability flags that absorbs the
 *              DIALECT differences between vendors speaking the same protocol
 *              (requiresToolResultName, cacheControlFormat, ...)
 *
 * Result: one openai-completions adapter serves ~25 vendors, each differing
 * only by provider config + compat flags.
 *
 * Usage: node s05_provider_matrix/code.ts   (offline, deterministic)
 */

// ---------------------------------------------------------------------------
// 1. The unified message model (what the kernel speaks - never changes)
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };
type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type AssistantBlock = TextBlock | ToolCallBlock;
type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: AssistantBlock[] }
	| { role: "toolResult"; toolCallId: string; content: string };

type ToolSchema = { name: string; description: string; parameters: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 2. Compat: typed capability flags for vendors speaking the same protocol
// ---------------------------------------------------------------------------

interface OpenaiCompat {
	/** Older OpenAI-compat dialects require "name" on tool result messages. */
	requiresToolResultName: boolean;
	/** Whether the endpoint tolerates parallel tool calls in one reply. */
	supportsParallelToolCalls: boolean;
}

const OPENAI_STANDARD: OpenaiCompat = { requiresToolResultName: false, supportsParallelToolCalls: true };
const OPENAI_LEGACY: OpenaiCompat = { requiresToolResultName: true, supportsParallelToolCalls: false };

// ---------------------------------------------------------------------------
// 3. The two adapters: unified -> wire (and back)
// ---------------------------------------------------------------------------

type WireApi = "anthropic-messages" | "openai-completions";

function toAnthropicWire(messages: Message[], tools: ToolSchema[]) {
	// Anthropic: system is a TOP-LEVEL param; tool results are user-turn blocks.
	const system = messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content).join("\n");
	const wireMessages = messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.content }] };
			if (m.role === "assistant") {
				return {
					role: "assistant",
					content: m.content.map((b) =>
						b.type === "text"
							? { type: "text", text: b.text }
							: { type: "tool_use", id: b.id, name: b.name, input: b.arguments },
					),
				};
			}
			return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
		});
	return {
		system,
		messages: wireMessages,
		tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
	};
}

function toOpenaiWire(messages: Message[], tools: ToolSchema[], compat: OpenaiCompat) {
	// OpenAI: system becomes the first chat message; tool results use role "tool".
	const wireMessages = messages.map((m) => {
		if (m.role === "system") return { role: "system", content: m.content };
		if (m.role === "user") return { role: "user", content: m.content };
		if (m.role === "assistant") {
			return {
				role: "assistant",
				content: m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n") || null,
				...(m.content.some((b) => b.type === "toolCall")
					? {
							tool_calls: m.content
								.filter((b): b is ToolCallBlock => b.type === "toolCall")
								.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.arguments) } })),
						}
					: {}),
			};
		}
		// The compat flag absorbs the dialect difference RIGHT HERE:
		const base: Record<string, unknown> = { role: "tool", tool_call_id: m.toolCallId, content: m.content };
		if (compat.requiresToolResultName) base["name"] = m.toolCallId; // legacy dialect quirk
		return base;
	});
	return {
		messages: wireMessages,
		tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
		parallel_tool_calls: compat.supportsParallelToolCalls,
	};
}

// ---------------------------------------------------------------------------
// 4. Provider: vendor = baseUrl + auth + api + compat + models
// ---------------------------------------------------------------------------

interface ProviderConfig {
	id: string;
	api: WireApi;
	baseUrl: string;
	apiKeyEnv: string;
	compat?: OpenaiCompat; // only meaningful for openai-completions
	models: Array<{ id: string; contextWindow: number; inputCostPerMTokens: number }>;
}

const PROVIDERS: ProviderConfig[] = [
	{
		id: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com/v1/messages",
		apiKeyEnv: "ANTHROPIC_API_KEY",
		models: [{ id: "claude-sonnet-4", contextWindow: 200_000, inputCostPerMTokens: 3 }],
	},
	{
		id: "deepseek",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com/chat/completions",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		compat: OPENAI_STANDARD,
		models: [{ id: "deepseek-chat", contextWindow: 128_000, inputCostPerMTokens: 0.27 }],
	},
	{
		id: "legacy-vendor",
		api: "openai-completions",
		baseUrl: "https://legacy.example.com/v1",
		apiKeyEnv: "LEGACY_KEY",
		compat: OPENAI_LEGACY, // same protocol, different dialect
		models: [{ id: "legacy-7b", contextWindow: 32_000, inputCostPerMTokens: 0.1 }],
	},
];

function buildRequestBody(provider: ProviderConfig, messages: Message[], tools: ToolSchema[]): unknown {
	return provider.api === "anthropic-messages"
		? toAnthropicWire(messages, tools)
		: toOpenaiWire(messages, tools, provider.compat ?? OPENAI_STANDARD);
}

// A tiny generated-catalog stand-in: pi's models.generated.ts is produced by
// scripts/generate-models.ts from provider catalogs - never hand-edited.
const CATALOG = PROVIDERS.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id })));
function resolveModel(modelId: string) {
	const hit = CATALOG.find((m) => m.id === modelId);
	if (!hit) throw new Error(`unknown model '${modelId}'`);
	return hit;
}

// ---------------------------------------------------------------------------
// 5. Demo: one conversation, three providers, zero kernel changes
// ---------------------------------------------------------------------------

function main() {
	console.log("s05: Provider Matrix\n");

	const conversation: Message[] = [
		{ role: "system", content: "You are a coding agent." },
		{ role: "user", content: "What files are here?" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Checking." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
			],
		},
		{ role: "toolResult", toolCallId: "call_1", content: "notes.txt todo.txt" },
	];

	const tools: ToolSchema[] = [
		{ name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	];

	for (const provider of PROVIDERS) {
		console.log(`\x1b[1m${provider.id}\x1b[0m  (api: ${provider.api}${provider.compat ? `, compat: ${provider.compat.requiresToolResultName ? "legacy" : "standard"}` : ""})`);
		const body = buildRequestBody(provider, conversation, tools);
		console.log(JSON.stringify(body, null, 1).slice(0, 1400));
		console.log("");
	}

	console.log("\x1b[1mSame unified conversation. Three request bodies. Kernel untouched.\x1b[0m");
	console.log("One openai-completions adapter + two compat flag sets served two vendors.\n");

	const model = resolveModel("deepseek-chat");
	console.log(`catalog: deepseek-chat -> provider '${model.provider}', ${model.contextWindow / 1000}k context, $${model.inputCostPerMTokens}/M input`);
	console.log("(pi's real catalog: ai/src/models.generated.ts, generated from provider directories)");
}

main();
