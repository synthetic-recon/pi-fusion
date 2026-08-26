import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, eq, fakeModel } from "./_harness.ts";
import registerFusionExtension, {
	activatePendingPanel,
	armPendingPanel,
	buildInitialState,
	clearPendingPanel,
	consumePendingPanel,
	fusionFooterText,
	normalizeFooterDisplay,
	parsePanelCommand,
	resolveModeCommandPanel,
} from "../index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PendingPanelSelection } from "../index.ts";

test("normalizeFooterDisplay accepts known footer modes", () => {
	eq(normalizeFooterDisplay("full"), "full", "full is accepted");
	eq(normalizeFooterDisplay("compact"), "compact", "compact is accepted");
	eq(normalizeFooterDisplay("off"), "off", "off is accepted");
});

test("normalizeFooterDisplay falls back to full", () => {
	eq(normalizeFooterDisplay(undefined), "full", "missing footer display falls back");
	eq(normalizeFooterDisplay("bad"), "full", "invalid footer display falls back");
});

test("parsePanelCommand consumes only a leading panel option and preserves prompt text", () => {
	eq(
		parsePanelCommand("--panel fast explain this  exactly"),
		{ ok: true, panelName: "fast", prompt: "explain this  exactly" },
		"leading option parsed",
	);
	eq(
		parsePanelCommand("--panel fast  preserve leading prompt space"),
		{ ok: true, panelName: "fast", prompt: " preserve leading prompt space" },
		"only one separator is consumed",
	);
	eq(
		parsePanelCommand("explain --panel fast as text"),
		{ ok: true, prompt: "explain --panel fast as text" },
		"non-leading option remains prompt text",
	);
});

test("parsePanelCommand rejects missing panel names and prompts", () => {
	const missingName = parsePanelCommand("--panel");
	if (missingName.ok) throw new Error("expected missing panel name failure");
	const missingPrompt = parsePanelCommand("--panel fast");
	if (missingPrompt.ok) throw new Error("expected missing prompt failure");
	if (!missingName.error.includes("name")) throw new Error(`unexpected error: ${missingName.error}`);
	if (!missingPrompt.error.includes("prompt")) throw new Error(`unexpected error: ${missingPrompt.error}`);
});

test("fusion tool schema exposes only prompt and context controls", () => {
	let parameters: unknown;
	registerFusionExtension({
		registerTool(tool: { parameters: unknown }) {
			parameters = tool.parameters;
		},
		registerCommand() {},
		on() {},
		getThinkingLevel: () => "off",
	} as never);

	const properties = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
	if (!properties) throw new Error("expected fusion tool parameters");
	eq(
		Object.keys(properties),
		["prompt", "context_mode", "context_turns"],
		"model-controlled schema remains user-configuration-free",
	);
});

test("/fusion on uses fusion.json / defaultPanel when session has no selectedIds", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-fusion-on-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "fusion.json"), JSON.stringify({
		defaultPanel: "quality",
		panels: {
			quality: {
				models: ["openai/gpt-4.1", "anthropic/claude-sonnet-4-5"],
				judge: "anthropic/claude-opus-4-5",
			},
		},
	}));

	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let persisted: { selectedIds?: string[]; mode?: string; judgeId?: string } | undefined;
	registerFusionExtension({
		registerTool() {},
		registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, spec);
		},
		on() {},
		appendEntry(_type: string, data: { selectedIds?: string[]; mode?: string; judgeId?: string }) {
			persisted = data;
		},
		getThinkingLevel: () => "off",
	} as never);

	const logs: string[] = [];
	const orig = console.log;
	console.log = (msg?: unknown) => {
		logs.push(String(msg ?? ""));
	};
	try {
		const handler = commands.get("fusion")?.handler;
		if (!handler) throw new Error("expected /fusion command");
		await handler("on", {
			cwd,
			isProjectTrusted: () => true,
			mode: "print",
			sessionManager: { getBranch: () => [] },
			ui: { notify() {}, setStatus() {} },
		});
		if (logs.some((line) => line.includes("No fusion setup"))) {
			throw new Error(`forced mode rejected config panel: ${logs.join(" | ")}`);
		}
		eq(persisted?.mode, "forced", "persisted forced mode");
		eq(persisted?.selectedIds, ["openai/gpt-4.1", "anthropic/claude-sonnet-4-5"], "persisted defaultPanel");
		eq(persisted?.judgeId, "anthropic/claude-opus-4-5", "persisted defaultPanel judge");
	} finally {
		console.log = orig;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("pending panel is session-bound, agent-bound, and consumed once", () => {
	let pending: PendingPanelSelection | undefined = armPendingPanel("fast", "session-a");
	eq(consumePendingPanel(pending, "session-a"), { panelName: undefined, pending }, "not consumed before agent start");
	pending = activatePendingPanel(pending, "session-a");
	eq(consumePendingPanel(pending, "session-b"), { panelName: undefined, pending }, "other session cannot consume");
	eq(consumePendingPanel(pending, "session-a"), { panelName: "fast", pending: undefined }, "matching run consumes once");
	eq(clearPendingPanel(pending, "session-b"), pending, "other session cannot clear");
	eq(clearPendingPanel(pending, "session-a"), undefined, "matching session clears");
});

test("fusionFooterText supports full, compact, and off display modes", () => {
	const panel = new Set(["anthropic/claude-sonnet-4-5", "openai/gpt-4.1"]);
	eq(
		fusionFooterText(panel, "anthropic/claude-opus-4-5", "available", "full"),
		"Fusion available • 2 panel • judge anthropic/claude-opus-4-5",
		"full footer includes judge",
	);
	eq(
		fusionFooterText(panel, "anthropic/claude-opus-4-5", "available", "full", {
			profileName: "quality",
			panelReasoning: "high",
			judgeReasoning: "xhigh",
		}),
		"Fusion available • named panel quality • 2 panel • panel reasoning high • judge reasoning xhigh • judge anthropic/claude-opus-4-5",
		"full status uses the canonical profile and reasoning order",
	);
	eq(
		fusionFooterText(panel, "anthropic/claude-opus-4-5", "available", "compact"),
		"Fusion available • 2 panel",
		"compact footer omits judge",
	);
	eq(
		fusionFooterText(panel, "anthropic/claude-opus-4-5", "available", "off"),
		undefined,
		"off footer hides fusion text",
	);
});

test("fusionFooterText hides footer text when panel is empty", () => {
	eq(fusionFooterText(new Set(), undefined, "available", "full"), undefined, "available mode with no panel hides text");
	eq(fusionFooterText(new Set(), undefined, "off", "full"), "Fusion off", "off mode still reports disabled state");
});

test("resolveModeCommandPanel uses config / defaultPanel when session has no snapshot", () => {
	const config = { selectedIds: new Set(["openai/gpt-4.1", "anthropic/claude-sonnet-4-5"]), judgeId: "anthropic/claude-opus-4-5" };
	const fromConfig = resolveModeCommandPanel({ selectedIds: new Set(), judgeId: undefined }, config);
	eq(fromConfig?.judgeId, "anthropic/claude-opus-4-5", "config judge used");
	eq([...(fromConfig?.selectedIds ?? [])], ["openai/gpt-4.1", "anthropic/claude-sonnet-4-5"], "config panel used");

	const session = { selectedIds: new Set(["session/panel"]), judgeId: "session/judge" };
	const fromSession = resolveModeCommandPanel(session, config);
	eq([...(fromSession?.selectedIds ?? [])], ["session/panel"], "session snapshot wins when present");

	eq(resolveModeCommandPanel({ selectedIds: new Set(), judgeId: undefined }, { selectedIds: new Set(), judgeId: undefined }), undefined, "empty session and config cannot arm forced");
});

function fakeContext(branch: unknown[] = []): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as ExtensionContext;
}

test("lifecycle refresh publishes and clears only Fusion's keyed status", async () => {
	type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

	const handlers = new Map<string, EventHandler>();
	let branch: unknown[] = [{
		type: "custom",
		customType: "fusion-state",
		data: {
			selectedIds: ["anthropic/claude-sonnet-4-5"],
			judgeId: "anthropic/claude-opus-4-5",
			footerDisplay: "full",
			profileName: "quality",
			panelReasoning: "high",
			judgeReasoning: "xhigh",
		},
	}];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	let footerCalls = 0;
	const ctx = {
		cwd: "/tmp/pi-fusion",
		isProjectTrusted: () => false,
		getContextUsage: () => ({ percent: 0, contextWindow: 128000 }),
		model: fakeModel("anthropic", "anthropic/claude-sonnet-4-5"),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		sessionManager: {
			getBranch: () => branch,
		},
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			setFooter: () => {
				footerCalls++;
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler);
		},
		getThinkingLevel: () => "off",
	};

	registerFusionExtension(pi as never);
	const refreshFooter = handlers.get("session_start");
	if (!refreshFooter) throw new Error("expected session_start handler to be registered");
	await refreshFooter({}, ctx);
	eq(
		statuses.at(-1),
		{
			key: "fusion",
			text: "Fusion available • 1 panel • panel reasoning high • judge reasoning xhigh • judge anthropic/claude-opus-4-5",
		},
		"session refresh publishes Fusion status",
	);
	eq(footerCalls, 0, "Fusion never replaces Pi's footer renderer");

	branch = [];
	const refreshTree = handlers.get("session_tree");
	if (!refreshTree) throw new Error("expected session_tree handler to be registered");
	await refreshTree({}, ctx);
	eq(statuses.at(-1), { key: "fusion", text: undefined }, "missing state clears stale Fusion status");
	eq(footerCalls, 0, "clearing status does not replace Pi's footer renderer");
});

test("buildInitialState seeds panel tools from config when session has no tool choice", () => {
	const state = buildInitialState(
		fakeContext(),
		[{ display: "anthropic/claude-sonnet-4-5" }],
		{ display: "anthropic/claude-opus-4-5" },
		"readonly",
		"compact",
	);
	eq(state.panelTools, "readonly", "config panelTools initializes setup state");
	eq(state.footerDisplay, "compact", "config footerDisplay initializes setup state");
});

test("buildInitialState lets config panel tools replace session none", () => {
	const state = buildInitialState(
		fakeContext([{
			type: "custom",
			customType: "fusion-state",
			data: {
				selectedIds: ["anthropic/claude-sonnet-4-5"],
				panelTools: "none",
			},
		}]),
		[{ display: "anthropic/claude-sonnet-4-5" }],
		{ display: "anthropic/claude-opus-4-5" },
		"readonly",
		"full",
	);
	eq(state.panelTools, "readonly", "session none does not mask config panelTools");
});

test("buildInitialState prefers session footer display over config", () => {
	const state = buildInitialState(
		fakeContext([{
			type: "custom",
			customType: "fusion-state",
			data: {
				selectedIds: ["anthropic/claude-sonnet-4-5"],
				footerDisplay: "off",
			},
		}]),
		[{ display: "anthropic/claude-sonnet-4-5" }],
		{ display: "anthropic/claude-opus-4-5" },
		"readonly",
		"full",
	);
	eq(state.footerDisplay, "off", "session footerDisplay wins");
});

test("buildInitialState uses configured status display when an older session has no override", () => {
	const state = buildInitialState(
		fakeContext([{
			type: "custom",
			customType: "fusion-state",
			data: {
				selectedIds: ["anthropic/claude-sonnet-4-5"],
			},
		}]),
		[{ display: "anthropic/claude-sonnet-4-5" }],
		{ display: "anthropic/claude-opus-4-5" },
		"none",
		"off",
	);
	eq(state.footerDisplay, "off", "missing session value does not override configured status display");
});

test("buildInitialState restores reasoning as a custom session snapshot", () => {
	const state = buildInitialState(
		fakeContext([{
			type: "custom",
			customType: "fusion-state",
			data: {
				selectedIds: ["openai/gpt-5.5"],
				judgeId: "openai/gpt-5.5",
				panelReasoning: "high",
				judgeReasoning: "xhigh",
			},
		}]),
		[{ display: "legacy/model" }],
		{ display: "legacy/judge" },
	);
	eq(state.profileName, undefined, "saved session is treated as a detached custom snapshot");
	eq(state.panelReasoning, "high", "panel effort restored");
	eq(state.judgeReasoning, "xhigh", "judge effort restored");
});
