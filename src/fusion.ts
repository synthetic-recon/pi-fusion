/**
 * Core fusion pipeline: panel execution + judge analysis.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	applyDefaults,
	loadConfig,
	PANEL_CONCURRENCY,
	type ResolvedFusionConfig,
} from "./config.ts";
import { buildFusionTaskText } from "./context.ts";
import { callModelText, callModelWithTools, getTextContent } from "./llm.ts";
import { modelDisplay, type ResolveOptions, resolvePanelAndJudge, type ResolveResult } from "./models.ts";
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
import type { FusionAnalysis, FusionDetails, FusionOptions, FusionResult, PanelResult, PanelToolUsage, ToolSelection } from "./types.ts";

/**
 * Classify a panel's final text. Blank output (a model that gathered tools but never
 * produced an answer, or hit the loop guard / token budget with nothing to show) is a
 * FAILURE, not a successful-but-empty response — so the judge only synthesizes real answers.
 */
export function emptyPanelError(content: string, capped: boolean): string | undefined {
	if (content.trim()) return undefined;
	return capped ? "no text answer (tool-call budget or loop guard hit)" : "empty response";
}

/** Build the panel/judge resolution options shared by resolveFusionModels and runFusion. */
function buildResolveOptions(
	config: ResolvedFusionConfig,
	overrides: FusionOptions,
	currentModel: Model<Api> | undefined,
): ResolveOptions {
	return {
		sessionPanel: overrides.analysis_models,
		sessionJudge: overrides.model ?? overrides.judge_model,
		configPanel: config.panel,
		configJudge: config.judge,
		configMaxPanelModels: config.maxPanelModels,
		currentModel,
	};
}

export async function resolveFusionModels(
	cwd: string,
	registry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	projectTrusted: boolean,
	overrides: FusionOptions,
): Promise<ResolveResult> {
	const config = applyDefaults(loadConfig(cwd, projectTrusted), overrides);
	return resolvePanelAndJudge(registry, buildResolveOptions(config, overrides, currentModel));
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
	const config = applyDefaults(loadConfig(cwd, projectTrusted), overrides);

	const maxPanelOutputTokens = config.maxPanelOutputTokens;
	const maxCompletionTokens = config.maxCompletionTokens;
	const temperature = config.temperature;
	const taskText = buildFusionTaskText(prompt, overrides.context_text);

	const { panel, judge, warnings } = await resolvePanelAndJudge(
		registry,
		buildResolveOptions(config, overrides, currentModel),
	);

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

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Fusion panel: ${panelModelNames.join(", ")} | judge: ${judgeName}${toolsLabel}${warnings.length > 0 ? " | warnings: " + warnings.join("; ") : ""}`,
			},
		],
		details: { phase: "resolving" },
	});

	// Run panel (serialized when mutating tools are active).
	const rawPanelResults = await mapWithConcurrencyLimit(panel, panelConcurrency, async (model): Promise<PanelResult> => {
		const base = { model: modelDisplay(model), provider: model.provider, id: model.id };
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
				);
				content = getTextContent(result.message);
				tools = { turns: result.turns, tool_calls: result.toolCalls, capped: result.cappedOut };
			} else {
				const response = await callModelText(registry, model, PANEL_SYSTEM_PROMPT, taskText, maxPanelOutputTokens, temperature, signal);
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
		details: { phase: successful.length === 1 ? "single_response" : "judging" },
	});

	let analysis: FusionAnalysis | undefined;
	if (successful.length >= 2) {
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

