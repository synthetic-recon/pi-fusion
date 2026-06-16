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
import { type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_MAX_TOOL_CALLS,
	generateConfigExample,
	loadConfig,
} from "./config.ts";
import { buildRecentContextFromEntries, type FusionContextMode, normalizeContextTurns } from "./context.ts";
import { resolveFusionModels, runFusion } from "./fusion.ts";
import { modelDisplay } from "./models.ts";
import { clampMaxToolCalls, isMutatingSelection, selectionLabel } from "./tools.ts";
import { selectFusionSetup, type FusionMode, type FusionSetupState } from "./ui.ts";
import { formatResult } from "./format.ts";
import type { FusionOptions, ToolMode } from "./types.ts";
const FusionParams = Type.Object(
	{
		prompt: Type.String({
			description:
				"The question, task, or topic to analyze. Be specific enough for independent models to answer.",
		}),
		// The fusion tool exposes ONLY the prompt and the conversation-context controls.
		// Panel, judge, tool access, max tool calls, temperature, and token budgets are all
		// user configuration (set via /fusion-setup or fusion.json) and always take
		// precedence — the invoking model must not override the user's setup.
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

function normalizeMode(state: { enabled?: boolean; mode?: FusionMode } | undefined): FusionMode {
	if (state?.mode) return state.mode;
	return state?.enabled ? "forced" : "available";
}

function modeLabel(mode: FusionMode): string {
	if (mode === "forced") return "Fusion forced";
	if (mode === "off") return "Fusion off";
	return "Fusion available";
}

function fusionFooterText(selectedIds: Set<string>, judgeId: string | undefined, mode: FusionMode = "available"): string | undefined {
	if (selectedIds.size === 0) return mode === "off" ? "Fusion off" : undefined;
	const panel = Array.from(selectedIds);
	const judge = judgeId ?? panel[0];
	return `${modeLabel(mode)} • ${panel.length} panel • judge ${judge}`;
}

/** Footer/status suffix describing panel tool access, when enabled. */
function toolsSuffix(state: FusionSetupState | undefined): string {
	const sel = state?.panelTools;
	if (!sel || sel === "none") return "";
	return ` • tools: ${selectionLabel(sel)}·${clampMaxToolCalls(state?.maxToolCalls)}${isMutatingSelection(sel) ? " ⚠" : ""}`;
}

/** Human-readable tools line for /fusion-status. */
function toolsStatusLine(state: FusionSetupState | undefined): string {
	const sel = state?.panelTools;
	if (!sel || sel === "none") return "Tools: off";
	const calls = clampMaxToolCalls(state?.maxToolCalls);
	return `Tools: ${selectionLabel(sel)} (max ${calls}${isMutatingSelection(sel) ? ", panel serialized" : ""})`;
}

function updateStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedIds: Set<string>,
	judgeId: string | undefined,
	mode: FusionMode = "available",
) {
	ctx.ui.setStatus("fusion", undefined);
	ctx.ui.setWidget("fusion-panel", undefined);

	const baseText = fusionFooterText(selectedIds, judgeId, mode);
	const fusionText = baseText ? baseText + toolsSuffix(effectiveDisplayState(ctx)) : baseText;
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

function persistSessionState(
	pi: ExtensionAPI,
	selectedIds: Set<string>,
	judgeId: string | undefined,
	mode: FusionMode = "available",
	tools: Pick<FusionSetupState, "panelTools" | "maxToolCalls" | "toolsConsented"> = {},
) {
	pi.appendEntry("fusion-state", {
		selectedIds: Array.from(selectedIds),
		judgeId,
		enabled: mode === "forced",
		mode,
		panelTools: tools.panelTools,
		maxToolCalls: tools.maxToolCalls,
		toolsConsented: tools.toolsConsented,
		timestamp: Date.now(),
	});
}

function restoreSessionState(ctx: ExtensionContext): FusionSetupState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "fusion-state" && "data" in entry && entry.data) {
			const data = entry.data as {
				selectedIds?: string[];
				judgeId?: string;
				enabled?: boolean;
				mode?: FusionMode;
				panelTools?: ToolMode;
				maxToolCalls?: number;
				toolsConsented?: boolean;
			};
			const mode = normalizeMode(data);
			return {
				selectedIds: new Set(data.selectedIds ?? []),
				judgeId: data.judgeId,
				enabled: mode === "forced",
				mode,
				panelTools: data.panelTools,
				maxToolCalls: data.maxToolCalls,
				toolsConsented: data.toolsConsented,
			};
		}
	}
	return undefined;
}

/**
 * What to show in the footer/status: the session selection if present, otherwise
 * the `fusion.json` config (so a configured panel shows without running /fusion-setup).
 * Returns undefined when nothing is configured at all.
 */
function effectiveDisplayState(ctx: ExtensionContext): FusionSetupState | undefined {
	const session = restoreSessionState(ctx);
	if (session?.selectedIds.size || normalizeMode(session) === "off") return session;
	const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
	if ((cfg.panel && cfg.panel.length > 0) || cfg.judge) {
		return {
			selectedIds: new Set(cfg.panel ?? []),
			judgeId: cfg.judge,
			mode: "available",
			panelTools: typeof cfg.panelTools === "string" ? cfg.panelTools : undefined,
			maxToolCalls: cfg.maxToolCalls,
		};
	}
	return session;
}

function sessionFusionOptions(ctx: ExtensionContext): FusionOptions {
	const sessionState = restoreSessionState(ctx);
	// Only contribute the session tool mode when it's an explicit non-"none" choice,
	// so the default "none" doesn't mask a fusion.json panelTools setting.
	const tools: FusionOptions = {
		panel_tools:
			sessionState?.panelTools && sessionState.panelTools !== "none" ? sessionState.panelTools : undefined,
		max_tool_calls: sessionState?.maxToolCalls,
	};
	if (!sessionState?.selectedIds.size) return tools;
	return {
		...tools,
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
		enabled: normalizeMode(sessionState) === "forced",
		mode: normalizeMode(sessionState),
		panelTools: sessionState?.panelTools ?? "none",
		maxToolCalls: sessionState?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
		toolsConsented: sessionState?.toolsConsented ?? false,
	};
}

type ModelWithDisplay = { display: string };

async function applySetup(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: FusionSetupState,
	warnings: string[],
): Promise<boolean> {
	if (state.selectedIds.size === 0) {
		ctx.ui.notify("At least one panel model must be selected", "error");
		return false;
	}
	// Judge is independent of the panel: it may be unset (auto) or a non-panel model.

	// Mutating panel tools require explicit consent. Without it, downgrade to read-only.
	let toolsConsented = state.toolsConsented ?? false;
	if (isMutatingSelection(state.panelTools) && !toolsConsented) {
		const ok = await ctx.ui.confirm(
			"Enable mutating panel tools?",
			"Panel models will be able to run bash and edit/write files in this project. The panel runs serialized (one model at a time). Continue?",
		);
		if (ok) {
			toolsConsented = true;
		} else {
			state.panelTools = "readonly";
			warnings.push("Mutating tools declined; using read-only.");
		}
	}
	state.toolsConsented = toolsConsented;

	const mode = normalizeMode(state);
	persistSessionState(pi, state.selectedIds, state.judgeId, mode, state);
	updateStatus(pi, ctx, state.selectedIds, state.judgeId, mode);
	const panelNames = Array.from(state.selectedIds).join(", ");
	const toolsNote = state.panelTools && state.panelTools !== "none"
		? `\nTools: ${selectionLabel(state.panelTools)} (max ${clampMaxToolCalls(state.maxToolCalls)})`
		: "";
	ctx.ui.notify(
		`Panel: ${panelNames}\nJudge: ${state.judgeId}${toolsNote}${warnings.length ? "\nWarnings: " + warnings.join("; ") : ""}`,
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
			const sessionState = restoreSessionState(ctx);
			if (normalizeMode(sessionState) === "off") {
				return {
					content: [{ type: "text", text: JSON.stringify({ status: "error", error: "fusion disabled" }, null, 2) }],
					details: { status: "error", responses: [], error: "fusion disabled", failure_reason: "unexpected_error" },
				};
			}
			const sessionOptions = sessionFusionOptions(ctx);
			const contextMode = (params.context_mode ?? "none") as FusionContextMode;
			const contextText = contextMode === "recent"
				? buildRecentContextFromEntries(ctx.sessionManager.getBranch(), normalizeContextTurns(params.context_turns))
				: undefined;
			// All config (panel, judge, tools, max-calls, tokens, temperature) comes ONLY from
			// the user's session selection → fusion.json → defaults, resolved inside runFusion.
			// The invoking model cannot set or override any of it; it controls only the prompt
			// and the conversation-context options above.
			const options: FusionOptions = {
				analysis_models: sessionOptions.analysis_models,
				model: sessionOptions.model,
				panel_tools: sessionOptions.panel_tools,
				max_tool_calls: sessionOptions.max_tool_calls,
				context_text: contextText,
			};
			return runFusion(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				params.prompt,
				ctx.isProjectTrusted(),
				options,
				ctx,
				sessionState?.toolsConsented ?? false,
				signal,
				onUpdate,
			);
		},
	});

	pi.registerCommand("fusion", {
		description: "Set fusion mode: /fusion on | available | off (no arg toggles available/forced; /fusion <prompt> forces once)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "on", label: "on", description: "Force every prompt through the panel" },
				{ value: "available", label: "available", description: "Let the model decide when to use fusion" },
				{ value: "off", label: "off", description: "Disable fusion for this session" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const sessionState = restoreSessionState(ctx);
			const lower = prompt.toLowerCase();
			const modeCommand: FusionMode | undefined =
				lower === "off" || lower === "disable" || lower === "disabled"
					? "off"
					: lower === "available" || lower === "auto"
						? "available"
						: lower === "forced" || lower === "force" || lower === "on"
							? "forced"
							: undefined;

			if (!prompt || modeCommand) {
				if (!sessionState?.selectedIds.size && (modeCommand === "forced" || (!prompt && !modeCommand))) {
					const message = "No fusion setup yet. Run /fusion-setup first, or use /fusion off to disable.";
					if (ctx.mode === "print") console.log(message);
					else ctx.ui.notify(message, "warning");
					return;
				}

				const selectedIds = sessionState?.selectedIds ?? new Set<string>();
				const judgeId = sessionState?.judgeId;
				const currentMode = normalizeMode(sessionState);
				const nextMode = modeCommand ?? (currentMode === "forced" ? "available" : "forced");
				persistSessionState(pi, selectedIds, judgeId, nextMode, sessionState ?? {});
				updateStatus(pi, ctx, selectedIds, judgeId, nextMode);
				const summary = (fusionFooterText(selectedIds, judgeId, nextMode) ?? modeLabel(nextMode)) + toolsSuffix(sessionState);
				if (ctx.mode === "print") console.log(summary);
				else ctx.ui.notify(summary, "info");
				return;
			}

			if (normalizeMode(sessionState) === "off") {
				const message = "Fusion is off. Use /fusion available or /fusion forced before using /fusion <prompt>.";
				if (ctx.mode === "print") console.log(message);
				else ctx.ui.notify(message, "warning");
				return;
			}

			if (sessionState?.selectedIds.size) {
				updateStatus(pi, ctx, sessionState.selectedIds, sessionState.judgeId, normalizeMode(sessionState));
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
			if (sessionState?.selectedIds.size) updateStatus(pi, ctx, sessionState.selectedIds, sessionState.judgeId, normalizeMode(sessionState));
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
					ctx,
					sessionState?.toolsConsented ?? false,
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

			if (!(await applySetup(pi, ctx, state, warnings))) return;
		},
	});


	pi.registerCommand("fusion-init", {
		description: "Create a project-local .pi/fusion.json template",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Project is not trusted; cannot write project-local config", "error");
				return;
			}

			const configDir = join(ctx.cwd, ".pi");
			const configPath = join(configDir, "fusion.json");
			// Seed the template from the user's actually-authed models so it works
			// immediately (no "model not authed" warnings from placeholder ids).
			let example: ReturnType<typeof generateConfigExample>;
			try {
				const { panel, judge } = await resolveFusionModels(
					ctx.cwd,
					ctx.modelRegistry,
					ctx.model,
					ctx.isProjectTrusted(),
					{},
				);
				example = generateConfigExample(panel.map(modelDisplay), modelDisplay(judge));
			} catch {
				example = generateConfigExample();
			}

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

			mkdirSync(configDir, { recursive: true });
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


	pi.registerCommand("fusion-status", {
		description: "Show the current fusion mode, panel, and judge",
		handler: async (_args, ctx) => {
			const session = restoreSessionState(ctx);
			const state = effectiveDisplayState(ctx);
			const fromConfig = !session?.selectedIds.size && !!state?.selectedIds.size;
			const lines: string[] = [];
			if (!state?.selectedIds.size) {
				lines.push(normalizeMode(state) === "off" ? "Fusion is off." : "Fusion is not set up. Run /fusion-setup or add a fusion.json.");
			} else {
				const mode = normalizeMode(state);
				lines.push(`Mode: ${mode}`);
				lines.push(`Panel: ${Array.from(state.selectedIds).join(", ")}${fromConfig ? "  (from fusion.json)" : ""}`);
				lines.push(`Judge: ${state.judgeId ?? Array.from(state.selectedIds)[0]}`);
				lines.push(toolsStatusLine(state));
				lines.push("");
				lines.push("Use /fusion to toggle available/forced, /fusion off to disable, /fusion <prompt> to force once. Change panel tools with /fusion-setup.");
				updateStatus(pi, ctx, state.selectedIds, state.judgeId, mode);
			}
			const text = lines.join("\n");
			if (ctx.mode === "print") console.log(text);
			else ctx.ui.notify(text, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "fusion") return;
		const state = restoreSessionState(ctx);
		if (normalizeMode(state) === "off") {
			return { block: true, reason: "Fusion is off for this session. Use /fusion available or /fusion forced to re-enable it." };
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().startsWith("/")) return { action: "continue" };
		if (isFusionPrompt(event.text.trim())) return { action: "continue" };
		const state = restoreSessionState(ctx);
		if (normalizeMode(state) !== "forced" || !state?.selectedIds.size) return { action: "continue" };
		updateStatus(pi, ctx, state.selectedIds, state.judgeId, "forced");
		return { action: "transform", text: forceFusionPrompt(event.text), images: event.images };
	});

	// Refresh the footer whenever the session/model changes (pi.on is overloaded per
	// event name, so register the shared handler for each rather than looping).
	const refreshFooter = (ctx: ExtensionContext) => {
		const state = effectiveDisplayState(ctx);
		if (state && (state.selectedIds.size || normalizeMode(state) === "off")) {
			updateStatus(pi, ctx, state.selectedIds, state.judgeId, normalizeMode(state));
		}
	};
	pi.on("session_start", async (_event, ctx) => refreshFooter(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshFooter(ctx));
	pi.on("model_select", async (_event, ctx) => refreshFooter(ctx));
}
