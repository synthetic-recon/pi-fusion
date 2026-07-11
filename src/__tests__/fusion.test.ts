/**
 * Tests for pi-fusion pipeline helpers.
 */

import { emptyPanelError, resolveFusionSelection, resolvePanelReasoning } from "../fusion.ts";
import { eq, fakeModel, test } from "./_harness.ts";

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

function registryFor(models: ReturnType<typeof fakeModel>[], authed: Set<string> = new Set(models.map((m) => `${m.provider}/${m.id}`))) {
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
		hasConfiguredAuth(model: ReturnType<typeof fakeModel>) {
			return authed.has(`${model.provider}/${model.id}`);
		},
	} as any;
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
	const supported = fakeModel("openai", "reasoner", { reasoning: true });
	const unsupported = fakeModel("plain", "model");
	const result = resolvePanelReasoning([supported, unsupported], "high");

	eq(result.effective, {
		"openai/reasoner": "high",
		"plain/model": null,
	}, "effective reasoning is recorded per model");
	eq(result.warnings, [
		"Reasoning high is not supported by plain/model; running that model without requested reasoning.",
	], "warnings follow panel order before concurrent calls");
});
