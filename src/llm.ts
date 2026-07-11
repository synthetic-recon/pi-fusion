/**
 * Low-level LLM calls for pi-fusion.
 */

import {
	complete,
	getSupportedThinkingLevels,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { TOOL_OUTPUT_MAX_BYTES } from "./config.ts";
import { modelDisplay } from "./models.ts";
import type { FusionToolDef } from "./tools.ts";
import { truncateToBytes } from "./utils.ts";

type ToolContent = ToolResultMessage["content"];

type CompleteOptions = {
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	maxTokens: number;
	temperature?: number;
	reasoning?: ThinkingLevel;
};

export interface ModelReasoningResolution {
	requested?: ThinkingLevel;
	effective?: ThinkingLevel;
	warning?: string;
}

/** Resolve without clamping so configured cost/effort changes are never silent. */
export function resolveModelReasoning(
	model: Model<Api>,
	requested: ThinkingLevel | undefined,
): ModelReasoningResolution {
	if (!requested) return {};
	if (getSupportedThinkingLevels(model).includes(requested)) {
		return { requested, effective: requested };
	}
	return {
		requested,
		warning: `Reasoning ${requested} is not supported by ${modelDisplay(model)}; running that model without requested reasoning.`,
	};
}

export async function buildCompleteOptions(
	registry: ModelRegistry,
	model: Model<Api>,
	maxTokens: number,
	temperature: number,
	signal: AbortSignal | undefined,
	reasoning?: ThinkingLevel,
): Promise<CompleteOptions> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${modelDisplay(model)}` : auth.error);
	}
	const options: CompleteOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal,
		maxTokens,
	};
	// Some models (e.g. Anthropic Claude Opus 4.7+, OpenAI Codex) reject temperature.
	if (getSupportsTemperature(model)) {
		options.temperature = temperature;
	}
	if (reasoning) options.reasoning = reasoning;
	return options;
}

export async function callModelText(
	registry: ModelRegistry,
	model: Model<Api>,
	systemPrompt: string,
	userText: string,
	maxTokens: number,
	temperature: number,
	signal: AbortSignal | undefined,
	reasoning?: ThinkingLevel,
): Promise<AssistantMessage> {
	const options = await buildCompleteOptions(registry, model, maxTokens, temperature, signal, reasoning);
	return runComplete(
		model,
		{ systemPrompt, messages: [{ role: "user", content: userText, timestamp: Date.now() }] },
		options,
	);
}

export interface ToolLoopResult {
	/** Final assistant message (its text is the panel answer). */
	message: AssistantMessage;
	/** Number of complete() calls made. */
	turns: number;
	/** Every tool call attempted, with success flag. */
	toolCalls: Array<{ name: string; ok: boolean }>;
	/** True when the loop was forced to finalize (cap or circuit breaker) before a natural stop. */
	cappedOut: boolean;
}

/**
 * Run a model through an internal agentic tool loop, bounded by `maxToolCalls`.
 *
 * The model may call the provided tools across multiple turns; each tool result
 * is fed back until the model returns text on its own, the cap is reached, or a
 * circuit breaker trips. On any forced finish, a final tool-free completion is
 * requested so the panel always returns a text answer.
 */
export async function callModelWithTools(
	registry: ModelRegistry,
	model: Model<Api>,
	systemPrompt: string,
	userText: string,
	maxTokens: number,
	temperature: number,
	signal: AbortSignal | undefined,
	toolDefs: FusionToolDef[],
	maxToolCalls: number,
	ctx: ExtensionContext,
	onToolEvent?: (ev: { name: string; turn: number; ok: boolean }) => void,
	reasoning?: ThinkingLevel,
): Promise<ToolLoopResult> {
	const options = await buildCompleteOptions(registry, model, maxTokens, temperature, signal, reasoning);
	const tools: Tool[] = toolDefs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
	const byName = new Map(toolDefs.map((d) => [d.name, d]));

	const messages: Message[] = [{ role: "user", content: userText, timestamp: Date.now() }];
	const toolCalls: Array<{ name: string; ok: boolean }> = [];
	let turns = 0;
	let used = 0;
	let lastKey: string | undefined;
	let repeatRun = 0;
	let errorStreak = 0;

	while (true) {
		const resp = await runComplete(model, { systemPrompt, messages, tools }, options);
		turns++;

		const calls = resp.content.filter((c): c is ToolCall => c.type === "toolCall");
		if (resp.stopReason !== "toolUse" || calls.length === 0) {
			return { message: resp, turns, toolCalls, cappedOut: false };
		}

		messages.push(resp);
		let forceFinalize = false;

		for (const tc of calls) {
			if (forceFinalize || used >= maxToolCalls) {
				// Every ToolCall must get a paired result or the next request 400s.
				messages.push(syntheticResult(tc, forceFinalize ? "stopped: repeated or failing tool calls" : "tool-call budget exhausted"));
				toolCalls.push({ name: tc.name, ok: false });
				continue;
			}

			const ok = await executeToolCall(tc, byName.get(tc.name), signal, ctx, messages);
			used++;
			toolCalls.push({ name: tc.name, ok });
			onToolEvent?.({ name: tc.name, turn: turns, ok });

			// Circuit breaker for TIGHT stuck-loops only: the exact same call (tool + args)
			// 3× in a row, or 3 consecutive errors. The key includes arguments, so varied
			// context-gathering — even many calls of the same tool with different paths/queries
			// — never trips it; only a model spinning on the identical call does. maxToolCalls
			// remains the hard upper bound.
			const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
			repeatRun = key === lastKey ? repeatRun + 1 : 1;
			lastKey = key;
			errorStreak = ok ? 0 : errorStreak + 1;
			if (repeatRun >= 3 || errorStreak >= 3) {
				forceFinalize = true;
			}
		}

		if (forceFinalize || used >= maxToolCalls) {
			// Tools exhausted or looping: ask for the final answer with tools omitted, and
			// nudge via the system prompt (some models go silent when tools disappear unless
			// explicitly told to answer now). System-prompt nudge avoids an illegal trailing
			// user message after tool results.
			const finalSystem = `${systemPrompt}\n\nYou have reached the tool-call limit. Write your complete final answer now using only what you have already gathered — do not request any more tools.`;
			const finalMsg = await runComplete(model, { systemPrompt: finalSystem, messages }, options);
			turns++;
			return { message: finalMsg, turns, toolCalls, cappedOut: true };
		}
	}
}

async function runComplete(
	model: Model<Api>,
	context: { systemPrompt: string; messages: Message[]; tools?: Tool[] },
	options: CompleteOptions,
): Promise<AssistantMessage> {
	const resp = await complete(model, context, options);
	if (resp.stopReason === "error" || resp.stopReason === "aborted") {
		throw new Error(resp.errorMessage ?? `Model stopped with reason: ${resp.stopReason}`);
	}
	return resp;
}

/** Execute one tool call, push its result message, and report success. Never throws. */
async function executeToolCall(
	tc: ToolCall,
	def: FusionToolDef | undefined,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	messages: Message[],
): Promise<boolean> {
	try {
		if (!def) throw new Error(`unknown tool: ${tc.name}`);
		// tc.arguments is already a parsed object — pass it straight through.
		// Cancellation flows through the explicit `signal` arg, which every built-in
		// tool honors (verified); no ctx.signal override is needed.
		const out = await def.execute(tc.id, tc.arguments, signal, undefined, ctx);
		messages.push({
			role: "toolResult",
			toolCallId: tc.id,
			toolName: tc.name,
			content: truncateToolContent(out.content),
			isError: false,
			timestamp: Date.now(),
		});
		return true;
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		messages.push({
			role: "toolResult",
			toolCallId: tc.id,
			toolName: tc.name,
			content: [{ type: "text", text: `Error: ${text}` }],
			isError: true,
			timestamp: Date.now(),
		});
		return false;
	}
}

function syntheticResult(tc: ToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: tc.id,
		toolName: tc.name,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: Date.now(),
	};
}

/** Bound tool output before it re-enters the loop transcript and the final answer. */
function truncateToolContent(content: ToolContent): ToolContent {
	return content.map((part) => {
		if (part.type !== "text") return part;
		const truncated = truncateToBytes(part.text, TOOL_OUTPUT_MAX_BYTES, "\n…[truncated]");
		return truncated === part.text ? part : { type: "text", text: truncated };
	});
}

export function getSupportsTemperature(model: Model<Api>): boolean {
	// Anthropic encodes this in model metadata (e.g. Opus 4.7+ set supportsTemperature:false,
	// and the Anthropic provider already withholds temperature accordingly). The `api`
	// discriminant narrows the value; `compat` still needs a precise (non-`any`) cast because
	// TS narrows the value, not the `Model` type parameter. See docs/pi-api-notes.md.
	if (model.api === "anthropic-messages") {
		const supported = (model as Model<"anthropic-messages">).compat?.supportsTemperature;
		if (typeof supported === "boolean") return supported;
	}
	// pi gap: no provider strips temperature for OpenAI Codex and no compat flag exists for it,
	// so this string match is the one genuinely load-bearing heuristic. See docs/pi-api-notes.md.
	const haystack = `${model.provider} ${model.id} ${model.baseUrl}`.toLowerCase();
	if (haystack.includes("codex")) return false;
	return true;
}

export function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
