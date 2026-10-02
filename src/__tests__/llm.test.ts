/**
 * Tests for provider/model request compatibility.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { buildCompleteOptions, callModelText, callModelWithTools, getSupportsTemperature, resolveModelReasoning } from "../llm.ts";
import type { Api, Model, ThinkingLevel } from "../types.ts";
import { eq, fakeModel, test } from "./_harness.ts";

test("openai-codex provider rejects temperature even when id does not contain codex", () => {
	const model = fakeModel("openai-codex", "gpt-5.5");
	if (getSupportsTemperature(model)) throw new Error("expected openai-codex/gpt-5.5 to omit temperature");
});

test("anthropic compat.supportsTemperature=false is honored", () => {
	const model = fakeModel("anthropic", "claude-opus-4-8", {
		api: "anthropic-messages" as Api,
		compat: { supportsTemperature: false } as Model<Api>["compat"],
	});
	if (getSupportsTemperature(model)) throw new Error("expected compat.supportsTemperature=false to omit temperature");
});

test("anthropic model without a compat flag defaults to supporting temperature", () => {
	// Regression for the dropped ^claude-opus-4-[7-9] regex: behavior now follows metadata only.
	const model = fakeModel("anthropic", "claude-opus-4-8", { api: "anthropic-messages" as Api });
	if (!getSupportsTemperature(model)) throw new Error("expected temperature when no compat flag is set");
});

test("ordinary openai-compatible model keeps temperature", () => {
	const model = fakeModel("openai", "gpt-4.1");
	if (!getSupportsTemperature(model)) throw new Error("expected regular model to support temperature");
});

test("resolveModelReasoning preserves supported effort and omits unsupported effort", () => {
	const supported = fakeModel("openai", "reasoner", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	});
	const unsupported = fakeModel("openai", "lower-ceiling", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	});

	eq(resolveModelReasoning(supported, "xhigh"), { requested: "xhigh", effective: "xhigh" }, "supported xhigh");
	eq(resolveModelReasoning(supported, "max"), { requested: "max", effective: "max" }, "supported max");
	eq(resolveModelReasoning(unsupported, "max"), {
		requested: "max",
		warning: "Reasoning max is not supported by openai/lower-ceiling; running that model without requested reasoning.",
	}, "unsupported max is omitted without clamping");
	eq(resolveModelReasoning(supported, undefined), {}, "unset reasoning is unchanged");
});

test("completion options preserve token and temperature inputs while adding reasoning", async () => {
	const model = fakeModel("openai", "reasoner", { reasoning: true });
	const options = await buildCompleteOptions({
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test", headers: { "x-test": "yes" } };
		},
	} as any, model, 2048, 0.3, undefined, "high");

	eq(options.maxTokens, 2048, "token cap input is unchanged");
	eq(options.temperature, 0.3, "temperature input is unchanged");
	eq(options.reasoning, "high", "supported reasoning is attached");
});

test("completion options omit temperature for GitHub Copilot gpt-5.6-sol", async () => {
	const model = fakeModel("github-copilot", "gpt-5.6-sol", { api: "openai-responses" as Api });
	const options = await buildCompleteOptions({
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test" };
		},
	} as any, model, 2048, 0.3, undefined);

	eq(Object.hasOwn(options, "temperature"), false, "unsupported temperature property is omitted");
});

test("completion options keep temperature for neighboring GitHub Copilot models", async () => {
	const model = fakeModel("github-copilot", "gpt-5.6", { api: "openai-responses" as Api });
	const options = await buildCompleteOptions({
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test" };
		},
	} as any, model, 2048, 0.3, undefined);

	eq(options.temperature, 0.3, "neighboring Copilot model retains temperature");
});

test("completion options keep temperature for gpt-5.6-sol under another provider", async () => {
	const model = fakeModel("openai", "gpt-5.6-sol", { api: "openai-responses" as Api });
	const options = await buildCompleteOptions({
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test" };
		},
	} as any, model, 2048, 0.3, undefined);

	eq(options.temperature, 0.3, "same model id under another provider retains temperature");
});

test("tool-loop finalization reuses max reasoning on every raw completion", async () => {
	const registration = registerFauxProvider({
		api: `fusion-reasoning-${Date.now()}`,
		provider: "fusion-test",
		models: [{ id: "reasoner", reasoning: true }],
	});
	const seen: Array<ThinkingLevel | undefined> = [];
	const toolEvents: string[] = [];
	registration.setResponses([
		(_context, options) => {
			seen.push((options as { reasoning?: ThinkingLevel } | undefined)?.reasoning);
			return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
		},
		(_context, options) => {
			seen.push((options as { reasoning?: ThinkingLevel } | undefined)?.reasoning);
			return fauxAssistantMessage("final answer");
		},
	]);

	try {
		await callModelWithTools(
			{ async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; } } as any,
			registration.getModel() as Model<Api>,
			"system",
			"task",
			2048,
			0.3,
			undefined,
			[{
				name: "probe",
				description: "probe",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
			}] as any,
			1,
			{} as any,
			(event) => toolEvents.push(event.name),
			"max",
		);
	} finally {
		registration.unregister();
	}

	eq(seen, ["max", "max"], "initial and forced-final completions share max reasoning");
	eq(toolEvents, ["probe"], "existing callback position remains compatible");
});

const probeTool = {
	name: "probe",
	description: "probe",
	parameters: { type: "object", properties: {} },
	async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
} as any;

/** A faux provider whose replies record that the direct compat path ran (and with which sessionId). */
function fauxCompat(responses: Array<"tool" | "text">) {
	const registration = registerFauxProvider({
		api: `fusion-dispatch-${Math.random().toString(36).slice(2)}`,
		provider: "fusion-dispatch",
		models: [{ id: "m" }],
	});
	const compatCalls: Array<string | undefined> = [];
	registration.setResponses(responses.map((kind) => (_context: unknown, options: unknown) => {
		compatCalls.push((options as { sessionId?: string } | undefined)?.sessionId);
		return kind === "tool"
			? fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })
			: fauxAssistantMessage("compat answer");
	}) as any);
	return { registration, model: registration.getModel() as Model<Api>, compatCalls };
}

/** A registry exposing pi >= 0.85 ModelRegistry.complete; records every dispatched sessionId. */
function registryWithComplete(replies: Array<"tool" | "text">) {
	const sessionIds: Array<string | undefined> = [];
	const registry = {
		async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; },
		async complete(_model: Model<Api>, _context: unknown, options: { sessionId?: string }) {
			sessionIds.push(options.sessionId);
			const kind = replies.shift() ?? "text";
			return kind === "tool"
				? fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })
				: fauxAssistantMessage("registry answer");
		},
	} as any;
	return { registry, sessionIds };
}

test("registry.complete is selected over compat and isolates independent calls by sessionId", async () => {
	const { registration, model, compatCalls } = fauxCompat(["text", "text"]);
	const { registry, sessionIds } = registryWithComplete(["text", "text"]);
	try {
		const first = await callModelText(registry, model, "system", "a", 256, 0.3, undefined);
		await callModelText(registry, model, "system", "b", 256, 0.3, undefined);
		eq(first.content, [{ type: "text", text: "registry answer" }], "response comes from registry.complete");
	} finally {
		registration.unregister();
	}

	eq(compatCalls.length, 0, "compat complete is not called when the registry provides complete()");
	eq(sessionIds.length, 2, "both calls dispatch through the registry");
	if (!sessionIds.every((id) => id?.startsWith("pi-fusion-"))) throw new Error(`unexpected session ids: ${sessionIds}`);
	if (sessionIds[0] === sessionIds[1]) throw new Error("independent calls must not share a sessionId");
});

test("every turn of one tool loop reuses a single sessionId through registry.complete", async () => {
	const { registration, model, compatCalls } = fauxCompat([]);
	// tool turn, then the forced final answer after the 1-call cap.
	const { registry, sessionIds } = registryWithComplete(["tool", "tool", "text"]);
	let result;
	try {
		result = await callModelWithTools(registry, model, "system", "task", 256, 0.3, undefined, [probeTool], 1, {} as any);
		await callModelText(registry, model, "system", "independent", 256, 0.3, undefined);
	} finally {
		registration.unregister();
	}

	eq(compatCalls.length, 0, "tool loop never falls back to compat");
	eq(result.cappedOut, true, "loop reached the forced-final turn");
	const loopIds = sessionIds.slice(0, -1);
	eq(loopIds.length, result.turns, "every loop turn dispatched through the registry");
	if (new Set(loopIds).size !== 1 || !loopIds[0]) throw new Error(`loop turns must share one sessionId: ${loopIds}`);
	if (sessionIds.at(-1) === loopIds[0]) throw new Error("a later independent call must get a fresh sessionId");
});

test("registries without complete() fall back to compat and still pass per-call sessionIds", async () => {
	const { registration, model, compatCalls } = fauxCompat(["text", "tool", "text"]);
	const registry = { async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; } } as any;
	try {
		const answer = await callModelText(registry, model, "system", "a", 256, 0.3, undefined);
		eq(answer.content, [{ type: "text", text: "compat answer" }], "fallback response comes from compat");
		await callModelWithTools(registry, model, "system", "task", 256, 0.3, undefined, [probeTool], 5, {} as any);
	} finally {
		registration.unregister();
	}

	eq(compatCalls.length, 3, "all completions use the compat path");
	if (!compatCalls.every((id) => id?.startsWith("pi-fusion-"))) throw new Error(`unexpected session ids: ${compatCalls}`);
	if (compatCalls[0] === compatCalls[1]) throw new Error("independent calls must not share a sessionId");
	eq(compatCalls[1], compatCalls[2], "tool-loop turns share one sessionId on the fallback path too");
});
