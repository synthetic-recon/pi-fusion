/**
 * Core fusion pipeline: panel execution + judge analysis.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	applyDefaults,
	DEFAULT_MAX_COMPLETION_TOKENS,
	DEFAULT_MAX_PANEL_OUTPUT_TOKENS,
	DEFAULT_TEMPERATURE,
	loadConfig,
	PANEL_CONCURRENCY,
} from "./config.ts";
import { callModelText, getTextContent } from "./llm.ts";
import { modelDisplay, resolvePanelAndJudge, type ResolveResult } from "./models.ts";
import { JUDGE_SYSTEM_PROMPT, PANEL_SYSTEM_PROMPT, truncateForJudge } from "./prompts.ts";
import { extractJson, mapWithConcurrencyLimit } from "./utils.ts";
import type { FusionAnalysis, FusionDetails, FusionOptions, FusionResult, PanelResult } from "./types.ts";

export async function resolveFusionModels(
	cwd: string,
	registry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	projectTrusted: boolean,
	overrides: FusionOptions,
): Promise<ResolveResult> {
	const baseConfig = loadConfig(cwd, projectTrusted);
	const config = applyDefaults(baseConfig, overrides);
	return resolvePanelAndJudge(registry, {
		sessionPanel: overrides.analysis_models,
		sessionJudge: overrides.model ?? overrides.judge_model,
		configPanel: config.panel,
		configJudge: config.judge,
		configMaxPanelModels: config.maxPanelModels,
		currentModel,
	});
}

export async function runFusion(
	cwd: string,
	registry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	prompt: string,
	projectTrusted: boolean,
	overrides: FusionOptions,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
): Promise<FusionResult> {
	const baseConfig = loadConfig(cwd, projectTrusted);
	const config = applyDefaults(baseConfig, overrides);

	const maxPanelOutputTokens = config.maxPanelOutputTokens ?? DEFAULT_MAX_PANEL_OUTPUT_TOKENS;
	const maxCompletionTokens = config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
	const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

	const { panel, judge, warnings } = await resolvePanelAndJudge(registry, {
		sessionPanel: overrides.analysis_models,
		sessionJudge: overrides.model ?? overrides.judge_model,
		configPanel: config.panel,
		configJudge: config.judge,
		configMaxPanelModels: config.maxPanelModels,
		currentModel,
	});

	const panelModelNames = panel.map(modelDisplay);
	const judgeName = modelDisplay(judge);

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Fusion panel: ${panelModelNames.join(", ")} | judge: ${judgeName}${warnings.length > 0 ? " | warnings: " + warnings.join("; ") : ""}`,
			},
		],
		details: { phase: "resolving" },
	});

	// Run panel in parallel.
	const rawPanelResults = await mapWithConcurrencyLimit(panel, PANEL_CONCURRENCY, async (model) => {
		const display = modelDisplay(model);
		try {
			const response = await callModelText(
				registry,
				model,
				PANEL_SYSTEM_PROMPT,
				prompt,
				maxPanelOutputTokens,
				temperature,
				signal,
			);
			const content = getTextContent(response);
			return { model: display, provider: model.provider, id: model.id, content };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { model: display, provider: model.provider, id: model.id, content: "", error: message };
		}
	});

	const successful = rawPanelResults.filter((r): r is PanelResult & { error: undefined } => !r.error);
	const failed = rawPanelResults.filter((r): r is PanelResult & { error: string } => !!r.error);

	if (successful.length === 0) {
		const details: FusionDetails = {
			status: "error",
			responses: [],
			failed_models: failed.map((f) => ({ model: f.model, error: f.error ?? "unknown error" })),
			panel_models: panelModelNames,
			judge_model: judgeName,
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
			`Task:\n${prompt}\n\n` +
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
		responses: successful.map((r) => ({ model: r.model, content: r.content })),
		...(failed.length > 0
			? { failed_models: failed.map((f) => ({ model: f.model, error: f.error ?? "unknown error" })) }
			: {}),
		panel_models: panelModelNames,
		judge_model: judgeName,
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

