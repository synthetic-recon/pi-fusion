/**
 * Tests for pi-fusion pipeline helpers.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactFusionToolText, emptyPanelError, parseFusionAnalysis, resolveFusionSelection, resolvePanelReasoning, runFusion } from "../fusion.ts";
import type { Api, Model, ThinkingLevel } from "../types.ts";
import { eq, fakeModel, test } from "./_harness.ts";

test("parseFusionAnalysis defaults missing arrays to empty", () => {
	const parsed = parseFusionAnalysis({ consensus: ["agreed"] });
	eq(parsed, {
		consensus: ["agreed"],
		contradictions: [],
		partial_coverage: [],
		unique_insights: [],
		blind_spots: [],
	}, "missing arrays default to []");
	eq(parseFusionAnalysis("not an object"), undefined, "non-object is unparseable");
	eq(parseFusionAnalysis(undefined), undefined, "missing JSON is unparseable");
	eq(parseFusionAnalysis({}), undefined, "empty object is not analysis");
	eq(parseFusionAnalysis({ foo: 1 }), undefined, "unrelated object is not analysis");
	eq(parseFusionAnalysis({ consensus: "string" }), undefined, "non-array analysis key is not analysis");
});

test("compactFusionToolText returns analysis plus excerpts, not full panel text", () => {
	const long = "PANEL-FULL-".repeat(80);
	const text = compactFusionToolText({
		status: "ok",
		analysis: { consensus: ["agreed"], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] },
		responses: [{ model: "a/m", content: long }],
		panel_models: ["a/m"],
		judge_model: "a/j",
	});
	if (!text.includes("agreed")) throw new Error("expected analysis in tool result");
	if (!text.includes("excerpts")) throw new Error("expected excerpts key");
	if (text.includes(long)) throw new Error("tool result must not include full panel answer");
	if (!text.includes("…")) throw new Error("expected truncated excerpt");
});

test("compactFusionToolText passes through a lone unjudged panel response", () => {
	const long = "PANEL-FULL-".repeat(80);
	const text = compactFusionToolText({
		status: "ok",
		responses: [{ model: "a/m", content: long }],
		panel_models: ["a/m"],
		judge_model: "a/j",
	});
	if (!text.includes(long)) throw new Error("single unjudged response must be returned in full");
});

test("emptyPanelError treats non-empty content as success", () => {
	eq(emptyPanelError("a real answer", false), undefined, "normal");
	eq(emptyPanelError("a real answer", true), undefined, "non-empty even if capped");
});

test("emptyPanelError flags blank/whitespace output as a failure", () => {
	eq(emptyPanelError("", false), "empty response", "empty");
	eq(emptyPanelError("   \n\t ", false), "empty response", "whitespace only");
});

test("emptyPanelError attributes a capped empty to the loop guard/budget", () => {
	eq(emptyPanelError("", true), "no text answer (tool-call budget or loop guard hit)", "capped + empty");
});

function registryFor(models: Model<Api>[], authed: Set<string> = new Set(models.map((m) => `${m.provider}/${m.id}`))) {
	return {
		find(provider: string, id: string) {
			return models.find((m) => m.provider === provider && m.id === id);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models.filter((m) => authed.has(`${m.provider}/${m.id}`));
		},
		hasConfiguredAuth(model: Model<Api>) {
			return authed.has(`${model.provider}/${model.id}`);
		},
	} as any;
}

function trustedProjectConfig(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-fusion-test-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "fusion.json"), "{}");
	return cwd;
}

test("selection preview exposes named panel metadata from the shared boundary", async () => {
	const named = fakeModel("named", "ready");
	const result = await resolveFusionSelection(
		{
			panels: { quality: { models: ["named/ready"], judge: "named/ready" } },
			defaultPanel: "quality",
		},
		registryFor([named]),
		undefined,
		{},
	);

	if (!result.ok) throw new Error(`unexpected selection failure: ${result.result.details.error}`);
	eq(result.resolution.profileName, "quality", "preview reports named panel");
	eq(result.resolution.source, "default", "preview reports default source");
});

test("one-shot named panel reasoning does not inherit a saved session profile", async () => {
	const named = fakeModel("named", "ready", { reasoning: true });
	const result = await resolveFusionSelection(
		{
			panelReasoning: "low",
			judgeReasoning: "medium",
			panels: {
				quality: {
					models: ["named/ready"],
					judge: "named/ready",
					panelReasoning: "xhigh",
				},
			},
		},
		registryFor([named]),
		undefined,
		{
			panel_profile: "quality",
			panel_reasoning: "minimal",
			judge_reasoning: "high",
		},
	);

	if (!result.ok) throw new Error(`unexpected selection failure: ${result.result.details.error}`);
	eq(result.config.panelReasoning, "xhigh", "explicit named panel keeps its own panel effort");
	eq(result.config.judgeReasoning, "medium", "explicit named panel inherits top-level judge effort");
});

test("strict named panel failure is structured and performs no provider calls", async () => {
	const locked = fakeModel("named", "locked");
	let providerCalls = 0;
	const registry = {
		...registryFor([locked], new Set()),
		async getApiKeyAndHeaders() {
			providerCalls++;
			return { ok: true, apiKey: "unused" };
		},
	} as any;

	const result = await resolveFusionSelection(
		{ panels: { quality: { models: ["named/locked"] } } },
		registry,
		undefined,
		{ panel_profile: "quality" },
	);

	if (result.ok) throw new Error("expected strict selection failure");
	eq(result.result.details.status, "error", "failure is a Fusion error result");
	eq(result.result.details.panel_profile, "quality", "failure identifies requested panel");
	eq(result.result.details.responses, [], "failure has no model responses");
	eq(providerCalls, 0, "strict failure makes no provider calls");
});

test("zero-auth default falls through to legacy with warnings and no auto substitution", async () => {
	const locked = fakeModel("named", "locked");
	const legacy = fakeModel("legacy", "ready");
	const result = await resolveFusionSelection(
		{
			panel: ["legacy/ready"],
			judge: "legacy/ready",
			panels: { quality: { models: ["named/locked"] } },
			defaultPanel: "quality",
		},
		registryFor([locked, legacy], new Set(["legacy/ready"])),
		undefined,
		{},
	);

	if (!result.ok) throw new Error(`unexpected selection failure: ${result.result.details.error}`);
	eq(result.resolution.panel.map((m) => `${m.provider}/${m.id}`), ["legacy/ready"], "legacy panel is recovered");
	eq(result.resolution.profileName, undefined, "failed default is not reported as active");
	if (!result.resolution.warnings.some((warning) => warning.includes("quality") && warning.includes("no authed models"))) {
		throw new Error(`missing default fallback warning: ${result.resolution.warnings.join("; ")}`);
	}
});

test("panel reasoning support is resolved deterministically in panel order", () => {
	const supported = fakeModel("openai", "reasoner", {
		reasoning: true,
		thinkingLevelMap: { max: "max" },
	});
	const unsupported = fakeModel("plain", "model", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	});
	const result = resolvePanelReasoning([supported, unsupported], "max");

	eq(result.effective, {
		"openai/reasoner": "max",
		"plain/model": null,
	}, "effective reasoning is recorded per model");
	eq(result.warnings, [
		"Reasoning max is not supported by plain/model; running that model without requested reasoning.",
	], "warnings follow panel order before concurrent calls");
});

test("runFusion dispatches max per model and preserves warning order", async () => {
	const unique = Math.random().toString(36).slice(2);
	const provider = `fusion-max-${unique}`;
	const registration = registerFauxProvider({
		api: `fusion-max-api-${unique}`,
		provider,
		models: [
			{ id: "panel-max", reasoning: true },
			{ id: "panel-lower", reasoning: true },
			{ id: "judge-max", reasoning: true },
		],
	});
	const panelMax = registration.getModel("panel-max") as Model<Api>;
	const panelLower = registration.getModel("panel-lower") as Model<Api>;
	const judgeMax = registration.getModel("judge-max") as Model<Api>;
	panelMax.thinkingLevelMap = { max: "max" };
	panelLower.thinkingLevelMap = { xhigh: "xhigh" };
	judgeMax.thinkingLevelMap = { max: "max" };

	const seen: Array<{ model: string; reasoning: ThinkingLevel | undefined }> = [];
	const record = (text: string) => (
		_context: unknown,
		options: unknown,
		_state: unknown,
		model: Model<Api>,
	) => {
		const reasoning = (options as { reasoning?: ThinkingLevel } | undefined)?.reasoning;
		seen.push({ model: model.id, reasoning });
		return fauxAssistantMessage(text);
	};
	registration.setResponses([
		record("supported panel answer"),
		record("lower-ceiling panel answer"),
		record(JSON.stringify({
			consensus: [],
			contradictions: [],
			partial_coverage: [],
			unique_insights: [],
			blind_spots: [],
		})),
	]);

	const cwd = trustedProjectConfig();
	const registry = {
		...registryFor([panelMax, panelLower, judgeMax]),
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test" };
		},
	} as any;

	try {
		const result = await runFusion(
			cwd,
			registry,
			undefined,
			"compare",
			true,
			{
				analysis_models: [`${provider}/panel-max`, `${provider}/panel-lower`],
				model: `${provider}/judge-max`,
				panel_reasoning: "max",
				judge_reasoning: "max",
			},
			{} as any,
			false,
			undefined,
		);

		eq(seen, [
			{ model: "panel-max", reasoning: "max" },
			{ model: "panel-lower", reasoning: undefined },
			{ model: "judge-max", reasoning: "max" },
		], "panel and judge calls receive only supported max reasoning");
		eq(result.details.responses.map((response) => response.model), [
			`${provider}/panel-max`,
			`${provider}/panel-lower`,
		], "successful responses retain configured panel order");
		eq(result.details.panel_reasoning, {
			requested: "max",
			effective: {
				[`${provider}/panel-max`]: "max",
				[`${provider}/panel-lower`]: null,
			},
		}, "panel diagnostics record supported and omitted max");
		eq(result.details.judge_reasoning, {
			requested: "max",
			effective: "max",
		}, "judge diagnostics record supported max");
		eq(result.details.warnings, [
			`Reasoning max is not supported by ${provider}/panel-lower; running that model without requested reasoning.`,
		], "only the lower-ceiling panel warns");
	} finally {
		registration.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("single panel success skips unsupported max judge without warning", async () => {
	const unique = Math.random().toString(36).slice(2);
	const provider = `fusion-skip-${unique}`;
	const registration = registerFauxProvider({
		api: `fusion-skip-api-${unique}`,
		provider,
		models: [
			{ id: "panel" },
			{ id: "judge-lower", reasoning: true },
		],
	});
	const panel = registration.getModel("panel") as Model<Api>;
	const judge = registration.getModel("judge-lower") as Model<Api>;
	judge.thinkingLevelMap = { xhigh: "xhigh" };
	const seen: string[] = [];
	registration.setResponses([
		(_context, _options, _state, model) => {
			seen.push(model.id);
			return fauxAssistantMessage("only panel answer");
		},
	]);

	const cwd = trustedProjectConfig();
	const registry = {
		...registryFor([panel, judge]),
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test" };
		},
	} as any;

	try {
		const result = await runFusion(
			cwd,
			registry,
			undefined,
			"single",
			true,
			{
				analysis_models: [`${provider}/panel`],
				model: `${provider}/judge-lower`,
				judge_reasoning: "max",
			},
			{} as any,
			false,
			undefined,
		);

		eq(seen, ["panel"], "judge provider is never called");
		eq(result.details.judge_reasoning, undefined, "skipped judge has no reasoning diagnostics");
		eq(result.details.warnings, undefined, "skipped unsupported judge does not warn");
		if (!result.content[0]?.text.includes("only panel answer")) {
			throw new Error("single unjudged panel answer must pass through the tool result");
		}
	} finally {
		registration.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("runFusion surfaces judge JSON failure instead of silent ok analysis", async () => {
	const unique = Math.random().toString(36).slice(2);
	const provider = `fusion-judge-fail-${unique}`;
	const registration = registerFauxProvider({
		api: `fusion-judge-fail-api-${unique}`,
		provider,
		models: [
			{ id: "panel-a" },
			{ id: "panel-b" },
			{ id: "judge" },
		],
	});
	const panelA = registration.getModel("panel-a") as Model<Api>;
	const panelB = registration.getModel("panel-b") as Model<Api>;
	const judge = registration.getModel("judge") as Model<Api>;
	registration.setResponses([
		() => fauxAssistantMessage("first panel answer that is long enough to be excerpted in the tool result"),
		() => fauxAssistantMessage("second panel answer that is long enough to be excerpted in the tool result"),
		() => fauxAssistantMessage("the judge said words but not JSON"),
	]);

	const cwd = trustedProjectConfig();
	const registry = {
		...registryFor([panelA, panelB, judge]),
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test" };
		},
	} as any;

	try {
		const result = await runFusion(
			cwd,
			registry,
			undefined,
			"compare",
			true,
			{
				analysis_models: [`${provider}/panel-a`, `${provider}/panel-b`],
				model: `${provider}/judge`,
			},
			{} as any,
			false,
			undefined,
		);

		eq(result.details.status, "ok", "panel success is still ok");
		eq(result.details.analysis, undefined, "unparseable judge has no analysis");
		eq(result.details.failure_reason, "unexpected_error", "judge failure is classified");
		if (!result.details.warnings?.some((w) => w.includes("unparseable"))) {
			throw new Error(`expected unparseable warning: ${result.details.warnings?.join("; ")}`);
		}
		const toolText = result.content[0]?.text ?? "";
		if (/"responses"\s*:/.test(toolText)) throw new Error("tool result should use excerpts, not full responses");
		if (!toolText.includes("excerpts")) throw new Error("expected excerpts in tool result");
		if (!toolText.includes("failure_reason")) throw new Error("tool result should surface failure_reason");
		eq(result.details.responses.length, 2, "details still keep full panel answers for /fusion-report");
	} finally {
		registration.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});
