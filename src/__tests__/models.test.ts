/**
 * Tests for pi-fusion model resolution and panel selection.
 */

import { modelDisplay, PanelSelectionError, resolvePanelAndJudge, selectDiversePanel } from "../models.ts";
import { eq, fakeModel, test } from "./_harness.ts";

test("modelDisplay formats provider/id", () => {
	const display = modelDisplay(fakeModel("anthropic", "claude-sonnet-4-5"));
	if (display !== "anthropic/claude-sonnet-4-5") throw new Error(`unexpected display: ${display}`);
});

test("selectDiversePanel picks one per provider by default", () => {
	const models = [
		fakeModel("anthropic", "claude-sonnet-4-5"),
		fakeModel("anthropic", "claude-opus-4-5"),
		fakeModel("openai", "gpt-4.1"),
		fakeModel("google", "gemini-2.5-pro"),
	];
	const panel = selectDiversePanel(models, 3);
	const providers = new Set(panel.map((m) => m.provider));
	if (panel.length !== 3) throw new Error(`expected 3, got ${panel.length}`);
	if (providers.size !== 3) throw new Error("expected 3 distinct providers");
});

test("selectDiversePanel excludes non-text models", () => {
	const textModel = fakeModel("anthropic", "claude-sonnet-4-5");
	const imageOnly = { ...fakeModel("openai", "dall-e"), input: ["image"] as ("text" | "image")[] };
	const panel = selectDiversePanel([textModel, imageOnly], 2);
	if (panel.length !== 1) throw new Error(`expected 1 text model, got ${panel.length}`);
	if (panel[0].id !== "claude-sonnet-4-5") throw new Error("unexpected model");
});

test("session panel preserves explicit 4-model selection despite auto default of 3", async () => {
	const models = [
		fakeModel("p1", "m1"),
		fakeModel("p2", "m2"),
		fakeModel("p3", "m3"),
		fakeModel("p4", "m4"),
	];
	const registry = {
		find(provider: string, id: string) {
			return models.find((m) => m.provider === provider && m.id === id);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
		hasConfiguredAuth() {
			return true;
		},
	} as any;

	const result = await resolvePanelAndJudge(registry, {
		sessionPanel: ["p1/m1", "p2/m2", "p3/m3", "p4/m4"],
		sessionJudge: "p4/m4",
	});

	if (result.panel.length !== 4) throw new Error(`expected 4 session panel models, got ${result.panel.length}`);
	if (result.judge.provider !== "p4" || result.judge.id !== "m4") throw new Error("expected session judge p4/m4");
});

test("auto panel still defaults to 3 models", async () => {
	const models = [
		fakeModel("p1", "m1"),
		fakeModel("p2", "m2"),
		fakeModel("p3", "m3"),
		fakeModel("p4", "m4"),
	];
	const registry = {
		getAvailable() {
			return models;
		},
		hasConfiguredAuth() {
			return true;
		},
	} as any;

	const result = await resolvePanelAndJudge(registry, {});
	if (result.panel.length !== 3) throw new Error(`expected auto panel default 3, got ${result.panel.length}`);
});

test("partially authed named default remains the selected candidate", async () => {
	const models = [fakeModel("named", "ready"), fakeModel("named", "locked"), fakeModel("legacy", "fallback")];
	const registry = {
		find(provider: string, id: string) {
			return models.find((m) => m.provider === provider && m.id === id);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models.filter((m) => m.id !== "locked");
		},
		hasConfiguredAuth(model: (typeof models)[number]) {
			return model.id !== "locked";
		},
	} as any;

	const result = await resolvePanelAndJudge(registry, {
		candidates: [
			{
				source: "default",
				profileName: "quality",
				panel: ["named/ready", "named/locked"],
				judge: "named/ready",
				maxPanelModels: 3,
			},
			{ source: "legacy", panel: ["legacy/fallback"], maxPanelModels: 3 },
		],
	});

	eq(result.panel.map(modelDisplay), ["named/ready"], "partial named panel is retained");
	eq(result.source, "default", "named default remains the source");
	eq(result.profileName, "quality", "named panel metadata is retained");
});

test("zero-auth named default retries legacy before auto selection", async () => {
	const models = [fakeModel("named", "locked"), fakeModel("legacy", "ready"), fakeModel("auto", "other")];
	let autoReads = 0;
	const registry = {
		find(provider: string, id: string) {
			return models.find((m) => m.provider === provider && m.id === id);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			autoReads++;
			return models.filter((m) => m.id !== "locked");
		},
		hasConfiguredAuth(model: (typeof models)[number]) {
			return model.id !== "locked";
		},
	} as any;

	const result = await resolvePanelAndJudge(registry, {
		candidates: [
			{ source: "default", profileName: "quality", panel: ["named/locked"], maxPanelModels: 3 },
			{ source: "legacy", panel: ["legacy/ready"], maxPanelModels: 3 },
		],
	});

	eq(result.panel.map(modelDisplay), ["legacy/ready"], "legacy panel wins before auto");
	eq(result.source, "legacy", "legacy source is reported");
	eq(autoReads, 0, "auto selection is not consulted after legacy succeeds");
});

test("session panel without a judge falls back to the configured judge", async () => {
	const panel = fakeModel("session", "panel");
	const judge = fakeModel("config", "judge");
	const models = [panel, judge];
	const registry = {
		find(provider: string, id: string) {
			return models.find((model) => model.provider === provider && model.id === id);
		},
		getAll: () => models,
		getAvailable: () => models,
		hasConfiguredAuth: () => true,
	} as any;

	const result = await resolvePanelAndJudge(registry, {
		candidates: [{ source: "session", panel: ["session/panel"], maxPanelModels: 8 }],
		autoJudge: "config/judge",
	});

	eq(modelDisplay(result.judge), "config/judge", "legacy session-to-config judge fallback is preserved");
});

test("strict zero-auth named panel stops without reading fallback models", async () => {
	const model = fakeModel("named", "locked");
	let autoReads = 0;
	const registry = {
		find() {
			return model;
		},
		getAll() {
			return [model];
		},
		getAvailable() {
			autoReads++;
			return [model];
		},
		hasConfiguredAuth() {
			return false;
		},
	} as any;

	let error: unknown;
	try {
		await resolvePanelAndJudge(registry, {
			candidates: [
				{ source: "explicit", profileName: "quality", panel: ["named/locked"], maxPanelModels: 3, strict: true },
				{ source: "legacy", panel: ["named/locked"], maxPanelModels: 3 },
			],
		});
	} catch (caught) {
		error = caught;
	}

	if (!(error instanceof PanelSelectionError)) throw new Error("expected a strict panel selection error");
	eq(error.profileName, "quality", "strict error identifies the named panel");
	eq(autoReads, 0, "strict failure never reaches auto selection");
});
