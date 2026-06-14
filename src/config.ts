/**
 * Fusion configuration loading and validation.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigValidationResult, FusionConfig } from "./types.ts";

export type { FusionConfig, ConfigValidationResult };

export const DEFAULT_MAX_PANEL_MODELS = 3;
export const DEFAULT_MAX_PANEL_OUTPUT_TOKENS = 2048;
export const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.3;
export const MAX_PANEL_MODELS_HARD_LIMIT = 8;
export const MIN_PANEL_MODELS = 1;
export const PANEL_CONCURRENCY = 4;

export function loadConfig(cwd: string, projectTrusted: boolean): FusionConfig {
	const paths: string[] = [];
	if (projectTrusted) {
		paths.push(join(cwd, ".pi", "fusion.json"));
	}
	paths.push(join(getAgentDir(), "fusion.json"));

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as FusionConfig;
		} catch (err) {
			console.error(`[pi-fusion] failed to parse ${path}:`, err);
		}
	}
	return {};
}

export function validateConfig(raw: unknown): ConfigValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (raw === null || typeof raw !== "object") {
		errors.push("Config must be a JSON object.");
		return { valid: false, config: {}, warnings, errors };
	}

	const config = raw as FusionConfig;

	if (config.panel !== undefined) {
		if (!Array.isArray(config.panel)) {
			errors.push("'panel' must be an array of model identifiers.");
		} else if (config.panel.length === 0) {
			errors.push("'panel' array must not be empty when provided.");
		} else if (config.panel.length > MAX_PANEL_MODELS_HARD_LIMIT) {
			errors.push(`'panel' may contain at most ${MAX_PANEL_MODELS_HARD_LIMIT} models.`);
		} else {
			for (const id of config.panel) {
				if (typeof id !== "string" || id.trim() === "") {
					errors.push("'panel' entries must be non-empty strings.");
					break;
				}
			}
		}
	}

	if (config.judge !== undefined) {
		if (typeof config.judge !== "string" || config.judge.trim() === "") {
			errors.push("'judge' must be a non-empty model identifier string.");
		}
	}

	if (config.maxPanelModels !== undefined) {
		if (
			typeof config.maxPanelModels !== "number" ||
			!Number.isInteger(config.maxPanelModels) ||
			config.maxPanelModels < MIN_PANEL_MODELS ||
			config.maxPanelModels > MAX_PANEL_MODELS_HARD_LIMIT
		) {
			errors.push(`'maxPanelModels' must be an integer between ${MIN_PANEL_MODELS} and ${MAX_PANEL_MODELS_HARD_LIMIT}.`);
		}
	}

	if (config.maxPanelOutputTokens !== undefined) {
		if (typeof config.maxPanelOutputTokens !== "number" || !Number.isInteger(config.maxPanelOutputTokens) || config.maxPanelOutputTokens < 1) {
			errors.push("'maxPanelOutputTokens' must be a positive integer.");
		}
	}

	if (config.maxCompletionTokens !== undefined) {
		if (typeof config.maxCompletionTokens !== "number" || !Number.isInteger(config.maxCompletionTokens) || config.maxCompletionTokens < 1) {
			errors.push("'maxCompletionTokens' must be a positive integer.");
		}
	}

	if (config.temperature !== undefined) {
		if (typeof config.temperature !== "number" || config.temperature < 0 || config.temperature > 2) {
			errors.push("'temperature' must be a number between 0 and 2.");
		}
	}

	if (config.panel === undefined && config.maxPanelModels === undefined) {
		warnings.push("No 'panel' configured; fusion will auto-select from authed models.");
	}

	if (config.judge === undefined) {
		warnings.push("No 'judge' configured; fusion will use the current or first panel model.");
	}

	return {
		valid: errors.length === 0,
		config,
		warnings,
		errors,
	};
}

export function applyDefaults(config: FusionConfig, overrides: {
	max_completion_tokens?: number;
	temperature?: number;
}): FusionConfig {
	return {
		...config,
		...(overrides.max_completion_tokens ? { maxCompletionTokens: overrides.max_completion_tokens } : {}),
		...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
	};
}

export function configDescription(config: FusionConfig): string {
	const parts: string[] = [];
	if (config.panel) parts.push(`panel=[${config.panel.join(", ")}]`);
	if (config.judge) parts.push(`judge=${config.judge}`);
	parts.push(`maxPanelModels=${config.maxPanelModels ?? DEFAULT_MAX_PANEL_MODELS}`);
	parts.push(`maxPanelOutputTokens=${config.maxPanelOutputTokens ?? DEFAULT_MAX_PANEL_OUTPUT_TOKENS}`);
	parts.push(`maxCompletionTokens=${config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS}`);
	parts.push(`temperature=${config.temperature ?? DEFAULT_TEMPERATURE}`);
	return parts.join(", ");
}

export function generateConfigExample(): FusionConfig {
	return {
		panel: [
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-4.1",
			"google/gemini-2.5-pro",
		],
		judge: "anthropic/claude-opus-4-5",
		maxPanelModels: DEFAULT_MAX_PANEL_MODELS,
		maxPanelOutputTokens: DEFAULT_MAX_PANEL_OUTPUT_TOKENS,
		maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
		temperature: DEFAULT_TEMPERATURE,
	};
}
