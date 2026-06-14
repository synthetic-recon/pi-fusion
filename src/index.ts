/**
 * pi-fusion: local multi-model deliberation inspired by OpenRouter Fusion.
 *
 * Runs a prompt against a panel of the authed models pi already has access to,
 * then asks a judge model to compare the responses and return structured
 * analysis (consensus, contradictions, partial coverage, unique insights,
 * blind spots). The outer model uses that analysis to write a better final
 * answer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	configDescription,
	DEFAULT_MAX_COMPLETION_TOKENS,
	DEFAULT_TEMPERATURE,
	generateConfigExample,
	MAX_PANEL_MODELS_HARD_LIMIT,
	validateConfig,
} from "./config.ts";
import { resolveFusionModels, runFusion } from "./fusion.ts";
import { listAuthedModels, modelDisplay } from "./models.ts";
import { renderConfigStatus, selectFusionSetup, showConfigSummary, type FusionSetupState } from "./ui.ts";
import type { FusionOptions } from "./types.ts";
const FusionParams = Type.Object(
	{
		prompt: Type.String({
			description:
				"The question, task, or topic to analyze. Be specific enough for independent models to answer.",
		}),
		analysis_models: Type.Optional(
			Type.Array(
				Type.String({
					description:
						"Optional panel model identifiers in provider/id form (e.g. anthropic/claude-sonnet-4-5). Overrides fusion.json for this call.",
				}),
				{ minItems: 1, maxItems: MAX_PANEL_MODELS_HARD_LIMIT },
			),
		),
		judge_model: Type.Optional(
			Type.String({
				description:
					"Optional judge model identifier in provider/id form. Overrides fusion.json for this call.",
			}),
		),
		max_completion_tokens: Type.Optional(
			Type.Integer({
				description: "Max tokens for each panel response and the judge analysis.",
				default: DEFAULT_MAX_COMPLETION_TOKENS,
			}),
		),
		temperature: Type.Optional(
			Type.Number({
				description: "Sampling temperature for panel and judge calls (0–2).",
				minimum: 0,
				maximum: 2,
				default: DEFAULT_TEMPERATURE,
			}),
		),
	},
	{ description: "Multi-model deliberation parameters" },
);

function updateStatus(
	ctx: ExtensionContext,
	selectedIds: Set<string>,
	judgeId: string | undefined,
) {
	const panel = Array.from(selectedIds);
	if (panel.length === 0) {
		ctx.ui.setStatus("fusion", undefined);
		ctx.ui.setWidget("fusion-panel", undefined);
		return;
	}
	const judge = judgeId && selectedIds.has(judgeId) ? judgeId : panel[0];
	ctx.ui.setStatus("fusion", `${panel.length} panel, judge: ${judge}`);
	ctx.ui.setWidget("fusion-panel", [`Panel: ${panel.join(", ")}`, `Judge: ${judge}`]);
}

function persistSessionState(pi: ExtensionAPI, selectedIds: Set<string>, judgeId: string | undefined) {
	pi.appendEntry("fusion-state", {
		selectedIds: Array.from(selectedIds),
		judgeId,
		timestamp: Date.now(),
	});
}

function restoreSessionState(ctx: ExtensionContext): FusionSetupState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "fusion-state" && "data" in entry && entry.data) {
			const data = entry.data as { selectedIds?: string[]; judgeId?: string };
			return {
				selectedIds: new Set(data.selectedIds ?? []),
				judgeId: data.judgeId,
			};
		}
	}
	return undefined;
}

function buildInitialState(
	ctx: ExtensionContext,
	resolvedPanel: ModelWithDisplay[],
	resolvedJudge: ModelWithDisplay,
): FusionSetupState {
	const sessionState = restoreSessionState(ctx);
	return {
		selectedIds: sessionState?.selectedIds ?? new Set(resolvedPanel.map((m) => m.display)),
		judgeId: sessionState?.judgeId ?? resolvedJudge.display,
	};
}

type ModelWithDisplay = { display: string };

function applySetup(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: FusionSetupState,
	warnings: string[],
): boolean {
	if (state.selectedIds.size === 0) {
		ctx.ui.notify("At least one panel model must be selected", "error");
		return false;
	}
	if (!state.judgeId || !state.selectedIds.has(state.judgeId)) {
		state.judgeId = Array.from(state.selectedIds)[0];
	}
	persistSessionState(pi, state.selectedIds, state.judgeId);
	updateStatus(ctx, state.selectedIds, state.judgeId);
	const panelNames = Array.from(state.selectedIds).join(", ");
	ctx.ui.notify(
		`Panel: ${panelNames}\nJudge: ${state.judgeId}${warnings.length ? "\nWarnings: " + warnings.join("; ") : ""}`,
		"info",
	);
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fusion",
		label: "Fusion",
		description: [
			"Multi-model deliberation tool inspired by OpenRouter Fusion.",
			"Use fusion when a single perspective is not enough: research questions, expert critique, compare/contrast tasks, or decisions where being wrong is expensive.",
			"Runs the prompt against a panel of authed models in parallel, then a judge compares responses and returns structured analysis (consensus, contradictions, partial coverage, unique insights, blind spots).",
			"Configure the panel and judge in ~/.pi/agent/fusion.json or .pi/fusion.json. Without a config, fusion picks a diverse panel from the authed models pi already has access to.",
		].join(" "),
		promptSnippet: "Run multi-model deliberation on complex research, critique, or comparison prompts.",
		promptGuidelines: [
			"Use the fusion tool when the user asks for multiple perspectives, expert critique, research synthesis, or comparison of complex topics.",
			"The fusion tool accepts a prompt and optional model overrides; it does not need file paths unless the prompt itself references them.",
		],
		parameters: FusionParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const options: FusionOptions = {
				analysis_models: params.analysis_models,
				judge_model: params.judge_model,
				max_completion_tokens: params.max_completion_tokens,
				temperature: params.temperature,
			};
			return runFusion(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				params.prompt,
				ctx.isProjectTrusted(),
				options,
				signal,
				onUpdate,
			);
		},
	});

	pi.registerCommand("fusion", {
		description: "Run multi-model fusion on a prompt",
		handler: async (args, ctx) => {
			const prompt = args.trim();

			if (ctx.mode === "print") {
				if (!prompt) {
					console.log("Usage: /fusion <prompt>");
					return;
				}
				const result = await runFusion(
					ctx.cwd,
					ctx.modelRegistry,
					ctx.model,
					prompt,
					ctx.isProjectTrusted(),
					{},
					ctx.signal,
				);
				console.log(result.content[0].text);
				return;
			}

			if (ctx.mode === "json" || ctx.mode === "rpc") {
				ctx.ui.notify("Fusion command is only available in interactive and print modes", "error");
				return;
			}

			if (!prompt) {
				ctx.ui.notify("Usage: /fusion <prompt>", "warning");
				return;
			}

			const sessionState = restoreSessionState(ctx);
			if (sessionState?.selectedIds.size) {
				updateStatus(ctx, sessionState.selectedIds, sessionState.judgeId);
			}

			const overrides: FusionOptions = sessionState?.selectedIds.size
				? {
						analysis_models: Array.from(sessionState.selectedIds),
						judge_model: sessionState.judgeId ?? Array.from(sessionState.selectedIds)[0],
				  }
				: {};

			ctx.ui.setWorkingMessage("Running fusion panel...");
			try {
				const fusionResult = await runFusion(
					ctx.cwd,
					ctx.modelRegistry,
					ctx.model,
					prompt,
					ctx.isProjectTrusted(),
					overrides,
					ctx.signal,
				);
				ctx.ui.setEditorText(fusionResult.content[0].text);
				ctx.ui.notify("Fusion complete. Result prefilled in editor.", "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Fusion failed: ${message}`, "error");
			} finally {
				ctx.ui.setWorkingMessage();
			}
		},
	});

	pi.registerCommand("fusion-setup", {
		description: "Open the fusion model setup UI",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("fusion-setup requires interactive mode", "error");
				return;
			}

			const available = ctx.modelRegistry.getAvailable().filter((m) => m.input.includes("text"));
			if (available.length === 0) {
				ctx.ui.notify("No authed text models available.", "error");
				return;
			}

			const { panel, judge, warnings } = await resolveFusionModels(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				ctx.isProjectTrusted(),
				{},
			);

			const initial: FusionSetupState = buildInitialState(
				ctx,
				panel.map((m) => ({ display: modelDisplay(m) })),
				{ display: modelDisplay(judge) },
			);

			const state = await selectFusionSetup(ctx, available, initial);
			if (!state) {
				ctx.ui.notify("Fusion setup cancelled", "info");
				return;
			}

			if (!applySetup(pi, ctx, state, warnings)) return;
		},
	});

	pi.registerCommand("fusion-run", {
		description: "Run fusion: open setup, enter prompt, and execute",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("fusion-run requires interactive mode", "error");
				return;
			}

			const available = ctx.modelRegistry.getAvailable().filter((m) => m.input.includes("text"));
			if (available.length === 0) {
				ctx.ui.notify("No authed text models available.", "error");
				return;
			}

			const { panel, judge, warnings } = await resolveFusionModels(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				ctx.isProjectTrusted(),
				{},
			);

			const initial: FusionSetupState = buildInitialState(
				ctx,
				panel.map((m) => ({ display: modelDisplay(m) })),
				{ display: modelDisplay(judge) },
			);

			const state = await selectFusionSetup(ctx, available, initial);
			if (!state) {
				ctx.ui.notify("Fusion run cancelled", "info");
				return;
			}

			if (!applySetup(pi, ctx, state, warnings)) return;

			const promptText = await ctx.ui.editor("Fusion prompt:", "");
			if (!promptText?.trim()) {
				ctx.ui.notify("No prompt entered. Setup saved for this session.", "info");
				return;
			}

			pi.sendUserMessage(`/fusion ${promptText.trim()}`);
		},
	});

	pi.registerCommand("fusion-config", {
		description: "Validate and display the active fusion configuration",
		handler: async (_args, ctx) => {
			const { loadConfig } = await import("./config.ts");
			const raw = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const validation = validateConfig(raw);
			const sessionState = restoreSessionState(ctx);

			if (ctx.mode === "print") {
				const lines: string[] = [];
				lines.push("## File Config");
				lines.push(configDescription(validation.config));
				if (sessionState?.selectedIds.size) {
					lines.push("");
					lines.push("## Session Selection");
					lines.push(`Panel: ${Array.from(sessionState.selectedIds).join(", ")}`);
					lines.push(`Judge: ${sessionState.judgeId ?? "auto"}`);
				}
				if (validation.warnings.length) {
					lines.push("");
					lines.push("## Warnings");
					for (const w of validation.warnings) lines.push(`- ${w}`);
				}
				if (validation.errors.length) {
					lines.push("");
					lines.push("## Errors");
					for (const e of validation.errors) lines.push(`- ${e}`);
				}
				console.log(lines.join("\n"));
				return;
			}

			await showConfigSummary(
				ctx,
				validation.config,
				validation.warnings,
				validation.errors,
				sessionState?.selectedIds.size ? Array.from(sessionState.selectedIds) : undefined,
				sessionState?.judgeId,
			);
		},
	});

	pi.registerCommand("fusion-init", {
		description: "Create a project-local .pi/fusion.json template",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Project is not trusted; cannot write project-local config", "error");
				return;
			}

			const configPath = join(ctx.cwd, ".pi", "fusion.json");
			const example = generateConfigExample();

			if (existsSync(configPath)) {
				const overwrite = await ctx.ui.confirm(
					".pi/fusion.json already exists",
					`Overwrite ${configPath} with the template?`,
				);
				if (!overwrite) {
					ctx.ui.notify("fusion-init cancelled", "info");
					return;
				}
			}

			writeFileSync(configPath, JSON.stringify(example, null, 2) + "\n", "utf8");

			const openConfig = await ctx.ui.confirm(
				"Created .pi/fusion.json",
				`Wrote template to ${configPath}. Open it in the editor to customize?`,
			);
			if (openConfig) {
				ctx.ui.setEditorText(JSON.stringify(example, null, 2));
			}
		},
	});

	pi.registerCommand("fusion-models", {
		description: "List authed models available for fusion panels",
		handler: async (_args, ctx) => {
			const models = listAuthedModels(ctx.modelRegistry);
			const lines = models.map((m) => `${m.selected ? "* " : "  "}${m.identifier} — ${m.name}`);
			const text = lines.length > 0 ? lines.join("\n") : "No authed text models available.";
			if (ctx.mode === "print") {
				console.log(text);
				return;
			}
			ctx.ui.setEditorText(text);
			ctx.ui.notify(`Listed ${models.length} authed text model(s)`, "info");
		},
	});

	pi.registerCommand("fusion-clear", {
		description: "Clear the current fusion panel selection",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Clear fusion panel?", "Remove all selected panel models and judge?");
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			persistSessionState(pi, new Set(), undefined);
			updateStatus(ctx, new Set(), undefined);
			ctx.ui.notify("Fusion panel cleared", "info");
		},
	});

	function updateStatus(
		ctx: ExtensionContext,
		selectedIds: Set<string>,
		judgeId: string | undefined,
	) {
		const panel = Array.from(selectedIds);
		if (panel.length === 0) {
			ctx.ui.setStatus("fusion", undefined);
			ctx.ui.setWidget("fusion-panel", undefined);
			return;
		}
		const judge = judgeId && selectedIds.has(judgeId) ? judgeId : panel[0];
		ctx.ui.setStatus("fusion", `${panel.length} panel, judge: ${judge}`);
		ctx.ui.setWidget("fusion-panel", [`Panel: ${panel.join(", ")}`, `Judge: ${judge}`]);
	}

	pi.on("session_start", async (_event, ctx) => {
		const state = restoreSessionState(ctx);
		if (state?.selectedIds.size) {
			updateStatus(ctx, state.selectedIds, state.judgeId);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const state = restoreSessionState(ctx);
		if (state?.selectedIds.size) {
			updateStatus(ctx, state.selectedIds, state.judgeId);
		}
	});
}
