/**
 * Tests for provider/model request compatibility.
 */

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { buildCompleteOptions, callModelWithTools, getSupportsTemperature, resolveModelReasoning } from "../llm.ts";
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
		thinkingLevelMap: { xhigh: "xhigh" },
	});
	const unsupported = fakeModel("openai", "plain");

	eq(resolveModelReasoning(supported, "xhigh"), { requested: "xhigh", effective: "xhigh" }, "supported xhigh");
	eq(resolveModelReasoning(unsupported, "high"), {
		requested: "high",
		warning: "Reasoning high is not supported by openai/plain; running that model without requested reasoning.",
	}, "unsupported reasoning is omitted with a model-specific warning");
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

test("tool-loop finalization reuses reasoning on every raw completion", async () => {
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
			"high",
		);
	} finally {
		registration.unregister();
	}

	eq(seen, ["high", "high"], "initial and forced-final completions share reasoning");
	eq(toolEvents, ["probe"], "existing callback position remains compatible");
});
