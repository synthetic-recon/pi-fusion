/**
 * Core fusion pipeline: panel execution + judge analysis.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	PANEL_CONCURRENCY,
	resolveEffectiveConfig,
	type ResolvedFusionConfig,
} from "./config.ts";
import { buildFusionTaskText } from "./context.ts";
import {
	callModelText,
	callModelWithTools,
	getTextContent,
	resolveModelReasoning,
} from "./llm.ts";
import {
	modelDisplay,
	PanelSelectionError,
	type ResolveCandidate,
	resolvePanelAndJudge,
	type ResolveResult,
} from "./models.ts";
import { JUDGE_SYSTEM_PROMPT, PANEL_SYSTEM_PROMPT, PANEL_SYSTEM_PROMPT_WITH_TOOLS, truncateForJudge } from "./prompts.ts";
import {
	clampMaxToolCalls,
	isMutatingSelection,
	MUTATING_TOOL_NAMES,
	resolveToolDefs,
	selectionLabel,
	selectionToNames,
} from "./tools.ts";
import { extractJson, mapWithConcurrencyLimit } from "./utils.ts";
import type {
	FusionAnalysis,
	FusionConfig,
	FusionDetails,
	FusionOptions,
	FusionResult,
	PanelResult,
	PanelToolUsage,
	ThinkingLevel,
	ToolSelection,
} from "./types.ts";

/**
 * Classify a panel's final text. Blank output (a model that gathered tools but never
 * produced an answer, or hit the loop guard / token budget with nothing to show) is a
 * FAILURE, not a successful-but-empty response — so the judge only synthesizes real answers.
 */
export function emptyPanelError(content: string, capped: boolean): string | undefined {
	if (content.trim()) return undefined;
	return capped ? "no text answer (tool-call budget or loop guard hit)" : "empty response";
}

export interface PanelReasoningPlan {
	requested?: ThinkingLevel;
	effective: Record<string, ThinkingLevel | null>;
	warnings: string[];
}

/** Resolve all panel support before concurrency so warnings and diagnostics are stable. */
export function resolvePanelReasoning(
	panel: Model<Api>[],
	requested: ThinkingLevel | undefined,
): PanelReasoningPlan {
	const effective: Record<string, ThinkingLevel | null> = {};
	const warnings: string[] = [];
	for (const model of panel) {
		const name = modelDisplay(model);
		const resolution = resolveModelReasoning(model, requested);
		effective[name] = resolution.effective ?? null;
		if (resolution.warning) warnings.push(resolution.warning);
	}
	return { requested, effective, warnings };
}

export type FusionSelectionResult =
	| { ok: true; config: ResolvedFusionConfig; resolution: ResolveResult }
	| { ok: false; result: FusionResult };

/**
 * Shared config -> candidate -> auth resolution boundary for previews and execution.
 * Named one-shot selection is internal extension state, not a registered tool input.
 */
export async function resolveFusionSelection(
	rawConfig: FusionConfig,
	registry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	overrides: FusionOptions,
): Promise<FusionSelectionResult> {
	const explicitProfile = overrides.panel_profile;
	// A one-shot named panel owns its model, judge, and reasoning snapshot. Keep
	// shared runtime overrides, but do not let a previously saved session profile's
	// reasoning leak into the explicit selection.
	const effectiveOverrides = explicitProfile
		? { ...overrides, panel_reasoning: undefined, judge_reasoning: undefined }
		: overrides;
	const effective = resolveEffectiveConfig(rawConfig, effectiveOverrides, explicitProfile);
	if (!effective.ok) {
		return selectionFailure(effective.error.message, effective.error.panelName, effective.warnings);
	}

	// Only a valid named default needs a separately normalized legacy fallback.
	// Explicit profiles fail closed, and legacy selections can reuse their result.
	let legacyResult: ReturnType<typeof resolveEffectiveConfig> = effective;
	if (effective.source === "default") {
		const legacyRaw = { ...rawConfig };
		delete legacyRaw.defaultPanel;
		legacyResult = resolveEffectiveConfig(legacyRaw, overrides);
	}
	if (!legacyResult.ok) {
		return selectionFailure(legacyResult.error.message, legacyResult.error.panelName, legacyResult.warnings);
	}
	const legacy = legacyResult;

	const candidates: ResolveCandidate[] = [];
	if (explicitProfile) {
		candidates.push({
			source: "explicit",
			profileName: effective.profileName,
			panel: effective.config.panel ?? [],
			judge: effective.config.judge,
			maxPanelModels: effective.config.maxPanelModels,
			strict: true,
		});
	} else {
		if (overrides.analysis_models?.length) {
			candidates.push({
				source: "session",
				panel: overrides.analysis_models,
				judge: overrides.model ?? overrides.judge_model,
				maxPanelModels: 8,
			});
		}
		if (effective.source === "default") {
			candidates.push({
				source: "default",
				profileName: effective.profileName,
				panel: effective.config.panel ?? [],
				judge: effective.config.judge,
				maxPanelModels: effective.config.maxPanelModels,
			});
		}
		if (legacy.config.panel?.length) {
			candidates.push({
				source: "legacy",
				panel: legacy.config.panel,
				judge: legacy.config.judge,
				maxPanelModels: legacy.config.maxPanelModels,
			});
		}
	}

	try {
		const resolution = await resolvePanelAndJudge(registry, {
			candidates,
			autoJudge: legacy.config.judge,
			autoMaxPanelModels: legacy.config.maxPanelModels,
			currentModel,
			warnings: effective.warnings,
		});
		const config = resolution.source === "explicit" || resolution.source === "default"
			? effective.config
			: legacy.config;
		return { ok: true, config, resolution };
	} catch (error) {
		if (error instanceof PanelSelectionError) {
			return selectionFailure(error.message, error.profileName, error.warnings);
		}
		throw error;
	}
}

function selectionFailure(message: string, profileName: string | undefined, warnings: string[]): FusionSelectionResult {
	const details: FusionDetails = {
		status: "error",
		responses: [],
		...(profileName ? { panel_profile: profileName } : {}),
		...(warnings.length ? { warnings } : {}),
		error: message,
		failure_reason: "unexpected_error",
	};
	return { ok: false, result: { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details } };
}

export async function resolveFusionModels(
	cwd: string,
	registry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	projectTrusted: boolean,
	overrides: FusionOptions,
): Promise<ResolveResult> {
	const selection = await resolveFusionSelection(loadConfig(cwd, projectTrusted), registry, currentModel, overrides);
	if (!selection.ok) throw new Error(selection.result.details.error ?? "Fusion model selection failed");
	return selection.resolution;
}

export async function runFusion(
	cwd: string,
	registry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	prompt: string,
	projectTrusted: boolean,
	overrides: FusionOptions,
	ctx: ExtensionContext,
	consented: boolean,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
): Promise<FusionResult> {
	const selection = await resolveFusionSelection(loadConfig(cwd, projectTrusted), registry, currentModel, overrides);
	if (!selection.ok) return selection.result;
	const { config, resolution } = selection;

	const maxPanelOutputTokens = config.maxPanelOutputTokens;
	const maxCompletionTokens = config.maxCompletionTokens;
	const temperature = config.temperature;
	const taskText = buildFusionTaskText(prompt, overrides.context_text);

	const { panel, judge, warnings, profileName, source } = resolution;
	const requestedPanelReasoning = source === "session"
		? overrides.panel_reasoning ?? config.panelReasoning
		: config.panelReasoning;
	const requestedJudgeReasoning = source === "session"
		? overrides.judge_reasoning ?? config.judgeReasoning
		: config.judgeReasoning;
	const panelReasoning = resolvePanelReasoning(panel, requestedPanelReasoning);
	warnings.push(...panelReasoning.warnings);
	const panelReasoningDetails = panelReasoning.requested
		? { requested: panelReasoning.requested, effective: panelReasoning.effective }
		: undefined;

	// Resolve panel tools. Fail-closed: mutating tools without consent are stripped
	// to the read-only subset. Mutating runs serialize the panel (concurrency 1).
	let toolSelection: ToolSelection | undefined = config.panelTools;
	const hasConsent = consented || config.panelToolsConsent === true;
	if (isMutatingSelection(toolSelection) && !hasConsent) {
		const readOnly = selectionToNames(toolSelection).filter(
			(n) => !(MUTATING_TOOL_NAMES as readonly string[]).includes(n),
		);
		toolSelection = readOnly.length ? readOnly : "none";
		warnings.push("Mutating panel tools require consent (run /fusion-setup or set panelToolsConsent in fusion.json); using read-only subset.");
	}
	const toolDefs = resolveToolDefs(toolSelection, cwd);
	const toolsEnabled = toolDefs.length > 0;
	const maxToolCalls = clampMaxToolCalls(config.maxToolCalls);
	const mutating = isMutatingSelection(toolSelection);
	const panelConcurrency = mutating ? 1 : PANEL_CONCURRENCY;

	const panelModelNames = panel.map(modelDisplay);
	const judgeName = modelDisplay(judge);
	const toolsLabel = toolsEnabled ? ` | tools: ${selectionLabel(toolSelection)}·${maxToolCalls}${mutating ? " (serialized)" : ""}` : "";
	const panelReasoningLabel = panelReasoningDetails
		? ` | panel reasoning: ${panelReasoningDetails.requested} (${Object.entries(panelReasoningDetails.effective).map(([name, level]) => `${name}=${level ?? "off"}`).join(", ")})`
		: "";
	const judgeReasoningLabel = requestedJudgeReasoning ? ` | judge reasoning requested: ${requestedJudgeReasoning}` : "";

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Fusion panel: ${panelModelNames.join(", ")} | judge: ${judgeName}${profileName ? ` | named panel: ${profileName}` : ""}${panelReasoningLabel}${judgeReasoningLabel}${toolsLabel}${warnings.length > 0 ? " | warnings: " + warnings.join("; ") : ""}`,
			},
		],
		details: { phase: "resolving", panel_profile: profileName, panel_reasoning: panelReasoningDetails },
	});

	// Run panel (serialized when mutating tools are active).
	const rawPanelResults = await mapWithConcurrencyLimit(panel, panelConcurrency, async (model): Promise<PanelResult> => {
		const base = { model: modelDisplay(model), provider: model.provider, id: model.id };
		const effectiveReasoning = panelReasoning.effective[base.model] ?? undefined;
		try {
			let content: string;
			let tools: PanelToolUsage | undefined;
			if (toolsEnabled) {
				const result = await callModelWithTools(
					registry,
					model,
					PANEL_SYSTEM_PROMPT_WITH_TOOLS,
					taskText,
					maxPanelOutputTokens,
					temperature,
					signal,
					toolDefs,
					maxToolCalls,
					ctx,
					undefined,
					effectiveReasoning,
				);
				content = getTextContent(result.message);
				tools = { turns: result.turns, tool_calls: result.toolCalls, capped: result.cappedOut };
			} else {
				const response = await callModelText(registry, model, PANEL_SYSTEM_PROMPT, taskText, maxPanelOutputTokens, temperature, signal, effectiveReasoning);
				content = getTextContent(response);
			}
			// Empty output is a failure, not a blank "success" — keep it out of the judge.
			const error = emptyPanelError(content, tools?.capped ?? false);
			return { ...base, content: error ? "" : content, ...(error ? { error } : {}), ...(tools ? { tools } : {}) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ...base, content: "", error: message };
		}
	});

	const successful = rawPanelResults.filter((r): r is PanelResult & { error: undefined } => !r.error);
	const failed = rawPanelResults.filter((r): r is PanelResult & { error: string } => !!r.error);

	if (successful.length === 0) {
		const details: FusionDetails = {
			status: "error",
			responses: [],
			failed_models: failed.map((f) => ({ model: f.model, error: f.error ?? "unknown error", ...(f.tools ? { tools: f.tools } : {}) })),
			panel_models: panelModelNames,
			judge_model: judgeName,
			...(profileName ? { panel_profile: profileName } : {}),
			...(panelReasoningDetails ? { panel_reasoning: panelReasoningDetails } : {}),
			...(warnings.length > 0 ? { warnings } : {}),
			error: "all panel models failed",
			failure_reason: classifyAllPanelFailure(failed),
		};
		return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
	}

	onUpdate?.({
		content: [
			{
				type: "text",
				text:
					successful.length === 1
						? `Panel complete (${successful.length}/${panel.length}). Only one model succeeded; skipping judge synthesis.`
						: `Panel complete (${successful.length}/${panel.length}). Running judge...`,
			},
		],
		details: { phase: successful.length === 1 ? "single_response" : "judging", panel_reasoning: panelReasoningDetails },
	});

	let analysis: FusionAnalysis | undefined;
	let judgeReasoningDetails: FusionDetails["judge_reasoning"];
	if (successful.length >= 2) {
		const judgeReasoning = resolveModelReasoning(judge, requestedJudgeReasoning);
		if (judgeReasoning.warning) warnings.push(judgeReasoning.warning);
		if (judgeReasoning.requested) {
			judgeReasoningDetails = {
				requested: judgeReasoning.requested,
				effective: judgeReasoning.effective ?? null,
			};
		}
		// Run judge.
		const judgeBudgetPerResponse = Math.max(
			1024,
			Math.floor(judge.contextWindow / Math.max(successful.length * 2, 8)),
		);
		const judgeUserText =
			`Task:\n${taskText}\n\n` +
			successful
				.map(
					(r) =>
						`--- Response from ${r.model} ---\n${truncateForJudge(r.content, judgeBudgetPerResponse)}`,
				)
				.join("\n\n");

		try {
			const judgeResponse = await callModelText(
				registry,
				judge,
				JUDGE_SYSTEM_PROMPT,
				judgeUserText,
				maxCompletionTokens,
				temperature,
				signal,
				judgeReasoning.effective,
			);
			const judgeText = getTextContent(judgeResponse);
			analysis = extractJson<FusionAnalysis>(judgeText);
		} catch (err) {
			console.error("[pi-fusion] judge failed:", err);
			analysis = undefined;
		}
	}

	const details: FusionDetails = {
		status: "ok",
		analysis,
		responses: successful.map((r) => ({ model: r.model, content: r.content, ...(r.tools ? { tools: r.tools } : {}) })),
		...(failed.length > 0
			? { failed_models: failed.map((f) => ({ model: f.model, error: f.error ?? "unknown error", ...(f.tools ? { tools: f.tools } : {}) })) }
			: {}),
		panel_models: panelModelNames,
		judge_model: judgeName,
		...(profileName ? { panel_profile: profileName } : {}),
		...(panelReasoningDetails ? { panel_reasoning: panelReasoningDetails } : {}),
		...(judgeReasoningDetails ? { judge_reasoning: judgeReasoningDetails } : {}),
		...(toolsEnabled
			? { panel_tools: { mode: selectionLabel(toolSelection), max_tool_calls: maxToolCalls, serialized: mutating } }
			: {}),
		...(warnings.length > 0 ? { warnings } : {}),
	};

	return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function classifyAllPanelFailure(failed: PanelResult[]): FusionDetails["failure_reason"] {
	const messages = failed.map((f) => (f.error ?? "").toLowerCase());
	if (messages.some((m) => m.includes("credit") || m.includes("quota") || m.includes("billing"))) {
		return "insufficient_credits";
	}
	if (messages.some((m) => m.includes("rate limit") || m.includes("429"))) {
		return "rate_limited";
	}
	return "all_panels_failed";
}
