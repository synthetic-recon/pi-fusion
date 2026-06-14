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
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
import { buildRecentContextFromEntries, type FusionContextMode, normalizeContextTurns } from "./context.ts";
import { resolveFusionModels, runFusion } from "./fusion.ts";
import { listAuthedModels, modelDisplay } from "./models.ts";
import { selectFusionSetup, showConfigSummary, type FusionSetupState } from "./ui.ts";
import { formatResult } from "./format.ts";
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
		model: Type.Optional(
			Type.String({
				description:
					"Optional judge model identifier in provider/id form. OpenRouter-compatible parameter name.",
			}),
		),
		judge_model: Type.Optional(
			Type.String({
				description:
					"Optional judge model identifier in provider/id form. Backward-compatible alias for model.",
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
		context_mode: Type.Optional(
			Type.Union([
				Type.Literal("none"),
				Type.Literal("recent"),
			], {
				description:
					"Whether to include conversation context for panel and judge calls. Use 'recent' when prior turns are needed; default is 'none'.",
				default: "none",
			}),
		),
		context_turns: Type.Optional(
			Type.Integer({
				description: "Number of recent user turns to include when context_mode is 'recent' (1–10). Default 4.",
				minimum: 1,
				maximum: 10,
				default: 4,
			}),
		),
	},
	{ description: "Multi-model deliberation parameters" },
);

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	return cwd;
}

function alignLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	const availableLeft = Math.max(0, width - rightWidth - 2);
	if (availableLeft > 0) {
		const truncatedLeft = truncateToWidth(left, availableLeft, "...");
		return truncatedLeft + " ".repeat(Math.max(1, width - visibleWidth(truncatedLeft) - rightWidth)) + right;
	}
	return truncateToWidth(right, width, "");
}

function fusionFooterText(selectedIds: Set<string>, judgeId: string | undefined, enabled = false): string | undefined {
	if (selectedIds.size === 0) return undefined;
	const panel = Array.from(selectedIds);
	const judge = judgeId && selectedIds.has(judgeId) ? judgeId : panel[0];
	return `${enabled ? "Fusion forced" : "Fusion available"} • ${panel.length} panel • judge ${judge}`;
}

function installFusionFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedIds: Set<string>,
	judgeId: string | undefined,
	enabled = false,
) {
	ctx.ui.setStatus("fusion", undefined);
	ctx.ui.setWidget("fusion-panel", undefined);

	const fusionText = fusionFooterText(selectedIds, judgeId, enabled);
	if (!fusionText) {
		ctx.ui.setFooter(undefined);
		return;
	}

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let cost = 0;
				let latestCacheHitRate: number | undefined;

				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const usage = entry.message.usage;
						input += usage.input;
						output += usage.output;
						cacheRead += usage.cacheRead;
						cacheWrite += usage.cacheWrite;
						cost += usage.cost.total;
						const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
					}
				}

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercent = contextUsage?.percent === null ? "?" : (contextUsage?.percent ?? 0).toFixed(1);
				const stats: string[] = [];
				if (input) stats.push(`↑${formatTokens(input)}`);
				if (output) stats.push(`↓${formatTokens(output)}`);
				if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);
				if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);
				if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
					stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
				if (cost || usingSubscription) stats.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				stats.push(`${contextPercent}%/${formatTokens(contextWindow)} (auto)`);

				let cwd = formatCwd(ctx.cwd);
				const branch = footerData.getGitBranch();
				if (branch) cwd += ` (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) cwd += ` • ${sessionName}`;

				let model = ctx.model?.id ?? "no-model";
				if (ctx.model?.reasoning) {
					const thinking = pi.getThinkingLevel();
					model = thinking === "off" ? `${model} • thinking off` : `${model} • ${thinking}`;
				}
				if (ctx.model && footerData.getAvailableProviderCount() > 1) {
					const withProvider = `(${ctx.model.provider}) ${model}`;
					if (visibleWidth(withProvider) < width) model = withProvider;
				}

				const top = alignLine(theme.fg("dim", cwd), fusionText ? theme.fg("dim", fusionText) : "", width);
				const bottom = alignLine(theme.fg("dim", stats.join(" ")), theme.fg("dim", model), width);
				return [top, bottom];
			},
		};
	});
}

function updateStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedIds: Set<string>,
	judgeId: string | undefined,
	enabled = false,
) {
	installFusionFooter(pi, ctx, selectedIds, judgeId, enabled);
}

function persistSessionState(pi: ExtensionAPI, selectedIds: Set<string>, judgeId: string | undefined, enabled = false) {
	pi.appendEntry("fusion-state", {
		selectedIds: Array.from(selectedIds),
		judgeId,
		enabled,
		timestamp: Date.now(),
	});
}

function restoreSessionState(ctx: ExtensionContext): FusionSetupState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "fusion-state" && "data" in entry && entry.data) {
			const data = entry.data as { selectedIds?: string[]; judgeId?: string; enabled?: boolean };
			return {
				selectedIds: new Set(data.selectedIds ?? []),
				judgeId: data.judgeId,
				enabled: data.enabled ?? false,
			};
		}
	}
	return undefined;
}

function sessionFusionOptions(ctx: ExtensionContext): FusionOptions {
	const sessionState = restoreSessionState(ctx);
	if (!sessionState?.selectedIds.size) return {};
	return {
		analysis_models: Array.from(sessionState.selectedIds),
		model: sessionState.judgeId ?? Array.from(sessionState.selectedIds)[0],
	};
}

function isFusionPrompt(text: string): boolean {
	return text.startsWith("Use the fusion tool for the following prompt before answering.");
}

function forceFusionPrompt(prompt: string): string {
	if (isFusionPrompt(prompt)) return prompt;
	return [
		"Use the fusion tool for the following prompt before answering.",
		"After the fusion tool returns, write the final answer yourself in your normal assistant voice.",
		"Do not simply paste the fusion JSON or raw panel responses unless the user explicitly asks for diagnostics.",
		"If prior conversation context is needed, call fusion with context_mode='recent' and a focused context_turns value.",
		"",
		prompt,
	].join("\n");
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
		enabled: sessionState?.enabled ?? false,
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
	persistSessionState(pi, state.selectedIds, state.judgeId, state.enabled ?? false);
	updateStatus(pi, ctx, state.selectedIds, state.judgeId, state.enabled ?? false);
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
			"Use the fusion tool only when a task genuinely benefits from multiple perspectives: research, expert critique, multi-domain analysis, compare/contrast decisions, architecture trade-offs, or anything where being wrong is expensive.",
			"Do not use the fusion tool for simple tactical prompts, straightforward edits, routine file operations, or questions a single model can answer well.",
			"Panel and judge calls do not automatically see the full conversation thread. If prior context matters, either include the relevant details in the prompt argument or set context_mode to 'recent' with an appropriate context_turns value.",
			"Use context_mode='recent' only when needed; keep context_turns small and focused because each panel model receives that context.",
			"The fusion tool accepts a prompt and optional model overrides; it does not need file paths unless the prompt itself references them.",
		],
		parameters: FusionParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const sessionOptions = sessionFusionOptions(ctx);
			const contextMode = (params.context_mode ?? "none") as FusionContextMode;
			const contextText = contextMode === "recent"
				? buildRecentContextFromEntries(ctx.sessionManager.getBranch(), normalizeContextTurns(params.context_turns))
				: undefined;
			const options: FusionOptions = {
				analysis_models: params.analysis_models ?? sessionOptions.analysis_models,
				model: params.model ?? params.judge_model ?? sessionOptions.model,
				max_completion_tokens: params.max_completion_tokens,
				temperature: params.temperature,
				context_text: contextText,
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
		description: "Toggle forced fusion mode, or force fusion for one prompt with /fusion <prompt>",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const sessionState = restoreSessionState(ctx);

			if (!prompt) {
				if (!sessionState?.selectedIds.size) {
					const message = "No fusion setup yet. Run /fusion-setup first.";
					if (ctx.mode === "print") console.log(message);
					else ctx.ui.notify(message, "warning");
					return;
				}

				const enabled = !(sessionState.enabled ?? false);
				persistSessionState(pi, sessionState.selectedIds, sessionState.judgeId, enabled);
				updateStatus(pi, ctx, sessionState.selectedIds, sessionState.judgeId, enabled);
				const summary = fusionFooterText(sessionState.selectedIds, sessionState.judgeId, enabled) ?? "Fusion off";
				if (ctx.mode === "print") console.log(summary);
				else ctx.ui.notify(summary, "info");
				return;
			}

			if (sessionState?.selectedIds.size) {
				updateStatus(pi, ctx, sessionState.selectedIds, sessionState.judgeId, sessionState.enabled ?? false);
			}

			if (ctx.mode === "print") {
				console.log(forceFusionPrompt(prompt));
				return;
			}

			pi.sendUserMessage(forceFusionPrompt(prompt));
		},
	});

	pi.registerCommand("fusion-report", {
		description: "Run fusion directly and write the raw panel/judge diagnostic report into the editor",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				const usage = "Usage: /fusion-report <prompt>";
				if (ctx.mode === "print") console.log(usage);
				else ctx.ui.notify(usage, "warning");
				return;
			}

			const sessionState = restoreSessionState(ctx);
			if (sessionState?.selectedIds.size) updateStatus(pi, ctx, sessionState.selectedIds, sessionState.judgeId, sessionState.enabled ?? false);
			const overrides = sessionFusionOptions(ctx);

			ctx.ui.setWorkingMessage("Running fusion report...");
			try {
				const result = await runFusion(
					ctx.cwd,
					ctx.modelRegistry,
					ctx.model,
					prompt,
					ctx.isProjectTrusted(),
					overrides,
					ctx.signal,
				);
				const failed = (result.details.failed_models ?? []).map((f) => ({
					model: f.model,
					provider: f.model.split("/")[0] ?? "",
					id: f.model.split("/").slice(1).join("/"),
					content: "",
					error: f.error,
				}));
				const responses = result.details.responses.map((r) => ({
					model: r.model,
					provider: r.model.split("/")[0] ?? "",
					id: r.model.split("/").slice(1).join("/"),
					content: r.content,
				}));
				const report = formatResult(result.details.analysis, responses, failed, {
					...result.details,
					panel_models: result.details.panel_models ?? [],
					judge_model: result.details.judge_model ?? "unknown",
				});
				if (ctx.mode === "print") console.log(report);
				else {
					ctx.ui.setEditorText(report);
					ctx.ui.notify("Fusion diagnostic report prefilled in editor.", "info");
				}
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
		description: "Advanced alias: setup, enter prompt, then force fusion once",
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

	pi.registerCommand("fusion-status", {
		description: "Show the current fusion mode, panel, and judge",
		handler: async (_args, ctx) => {
			const state = restoreSessionState(ctx);
			const lines: string[] = [];
			if (!state?.selectedIds.size) {
				lines.push("Fusion is not set up. Run /fusion-setup.");
			} else {
				lines.push(`Mode: ${state.enabled ? "forced for every normal prompt" : "available when the active model decides it is useful"}`);
				lines.push(`Panel: ${Array.from(state.selectedIds).join(", ")}`);
				lines.push(`Judge: ${state.judgeId ?? Array.from(state.selectedIds)[0]}`);
				lines.push("");
				lines.push("Use /fusion to toggle forced mode, /fusion <prompt> to force once, /fusion-setup to change models.");
				updateStatus(pi, ctx, state.selectedIds, state.judgeId, state.enabled ?? false);
			}
			const text = lines.join("\n");
			if (ctx.mode === "print") console.log(text);
			else ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("fusion-clear", {
		description: "Advanced: clear the current fusion panel selection",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Clear fusion panel?", "Remove all selected panel models and judge?");
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			persistSessionState(pi, new Set(), undefined, false);
			updateStatus(pi, ctx, new Set(), undefined, false);
			ctx.ui.notify("Fusion panel cleared", "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().startsWith("/")) return { action: "continue" };
		if (isFusionPrompt(event.text.trim())) return { action: "continue" };
		const state = restoreSessionState(ctx);
		if (!state?.enabled || !state.selectedIds.size) return { action: "continue" };
		updateStatus(pi, ctx, state.selectedIds, state.judgeId, true);
		return { action: "transform", text: forceFusionPrompt(event.text), images: event.images };
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = restoreSessionState(ctx);
		if (state?.selectedIds.size) {
			updateStatus(pi, ctx, state.selectedIds, state.judgeId, state.enabled ?? false);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const state = restoreSessionState(ctx);
		if (state?.selectedIds.size) {
			updateStatus(pi, ctx, state.selectedIds, state.judgeId, state.enabled ?? false);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		const state = restoreSessionState(ctx);
		if (state?.selectedIds.size) {
			updateStatus(pi, ctx, state.selectedIds, state.judgeId, state.enabled ?? false);
		}
	});
}
