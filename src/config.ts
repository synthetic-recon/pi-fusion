/**
 * Fusion configuration loading and validation.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ConfigSelectionError,
	EffectiveConfigResult,
	FusionConfig,
	NamedPanelConfig,
	ResolvedFusionConfig,
	ThinkingLevel,
} from "./types.ts";

export type { FusionConfig, ResolvedFusionConfig };

export const DEFAULT_MAX_PANEL_MODELS = 3;
export const DEFAULT_MAX_PANEL_OUTPUT_TOKENS = 2048;
export const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.3;
export const MAX_PANEL_MODELS_HARD_LIMIT = 8;
export const PANEL_CONCURRENCY = 4;

export const DEFAULT_MAX_TOOL_CALLS = 16;
export const MIN_TOOL_CALLS = 1;
export const MAX_TOOL_CALLS = 100;
/** Per tool result, before it re-enters the loop transcript (keeps panel context bounded). */
export const TOOL_OUTPUT_MAX_BYTES = 12_000;

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export interface FusionConfigOverrides {
	max_completion_tokens?: number;
	temperature?: number;
	panel_tools?: FusionConfig["panelTools"];
	max_tool_calls?: number;
	panel_reasoning?: ThinkingLevel;
	judge_reasoning?: ThinkingLevel;
}

export function loadConfig(cwd: string, projectTrusted: boolean): FusionConfig {
	const paths: string[] = [];
	if (projectTrusted) {
		paths.push(join(cwd, ".pi", "fusion.json"));
	}
	paths.push(join(getAgentDir(), "fusion.json"));

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			return parseFusionConfig(readFileSync(path, "utf8"));
		} catch (err) {
			console.error(`[pi-fusion] failed to parse ${path}:`, err);
		}
	}
	return {};
}

export function parseFusionConfig(text: string): FusionConfig {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new Error("Fusion config root must be a JSON object.");
	return parsed as FusionConfig;
}

export function applyDefaults(config: FusionConfig, overrides: FusionConfigOverrides): ResolvedFusionConfig {
	const merged: FusionConfig = {
		...config,
		...(overrides.max_completion_tokens ? { maxCompletionTokens: overrides.max_completion_tokens } : {}),
		...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
		...(overrides.panel_tools !== undefined ? { panelTools: overrides.panel_tools } : {}),
		...(overrides.max_tool_calls !== undefined ? { maxToolCalls: overrides.max_tool_calls } : {}),
		...(overrides.panel_reasoning !== undefined ? { panelReasoning: overrides.panel_reasoning } : {}),
		...(overrides.judge_reasoning !== undefined ? { judgeReasoning: overrides.judge_reasoning } : {}),
	};
	// Single source of truth for defaults: callers can read these numeric knobs directly.
	return {
		...merged,
		maxPanelModels: merged.maxPanelModels ?? DEFAULT_MAX_PANEL_MODELS,
		maxPanelOutputTokens: merged.maxPanelOutputTokens ?? DEFAULT_MAX_PANEL_OUTPUT_TOKENS,
		maxCompletionTokens: merged.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
		temperature: merged.temperature ?? DEFAULT_TEMPERATURE,
		maxToolCalls: merged.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
	};
}

/**
 * Select and normalize user-owned panel config before model/auth resolution.
 * Explicit selections fail closed; invalid configured defaults warn and retain
 * the legacy config so the model resolver can continue to legacy/auto selection.
 */
export function resolveEffectiveConfig(
	config: FusionConfig,
	overrides: FusionConfigOverrides = {},
	explicitPanel?: string,
): EffectiveConfigResult {
	const warnings: string[] = [];
	const normalized = normalizeTopLevelReasoning(config, warnings);

	if (explicitPanel !== undefined) {
		const selected = readNamedPanel(normalized, explicitPanel);
		if (!selected.ok) return { ok: false, error: selected.error, warnings };
		return {
			ok: true,
			config: applyDefaults(applyNamedPanel(normalized, selected.panel), overrides),
			profileName: explicitPanel,
			source: "explicit",
			warnings,
		};
	}

	const rawDefault = (normalized as { defaultPanel?: unknown }).defaultPanel;
	if (rawDefault !== undefined) {
		if (typeof rawDefault !== "string" || rawDefault.trim().length === 0) {
			warnings.push("Configured defaultPanel must be a non-empty string; falling back to legacy or auto selection.");
		} else {
			const selected = readNamedPanel(normalized, rawDefault);
			if (selected.ok) {
				return {
					ok: true,
					config: applyDefaults(applyNamedPanel(normalized, selected.panel), overrides),
					profileName: rawDefault,
					source: "default",
					warnings,
				};
			}
			warnings.push(
				`Configured defaultPanel "${rawDefault}" is invalid: ${selected.error.message} Falling back to legacy or auto selection.`,
			);
		}
	}

	return {
		ok: true,
		config: applyDefaults(normalized, overrides),
		source: "legacy",
		warnings,
	};
}

function normalizeTopLevelReasoning(config: FusionConfig, warnings: string[]): FusionConfig {
	const normalized = { ...config };
	for (const key of ["panelReasoning", "judgeReasoning"] as const) {
		const value = (config as Record<string, unknown>)[key];
		if (value !== undefined && !isThinkingLevel(value)) {
			delete normalized[key];
			warnings.push(
				`Invalid ${key} value; omitting it. Expected ${THINKING_LEVELS.join(", ")}.`,
			);
		}
	}
	return normalized;
}

function readNamedPanel(
	config: FusionConfig,
	panelName: string,
): { ok: true; panel: NamedPanelConfig } | { ok: false; error: ConfigSelectionError } {
	if (!panelName.trim()) {
		return invalidPanel(panelName, "Named panel name must be a non-empty string.");
	}

	const panels = (config as { panels?: unknown }).panels;
	if (!isRecord(panels) || !Object.hasOwn(panels, panelName)) {
		return {
			ok: false,
			error: {
				code: "unknown_named_panel",
				panelName,
				message: `Named panel "${panelName}" is not configured.`,
			},
		};
	}

	const value = panels[panelName];
	if (!isRecord(value)) {
		return invalidPanel(panelName, `Named panel "${panelName}" must be an object.`);
	}
	if (!Array.isArray(value.models) || value.models.length === 0) {
		return invalidPanel(panelName, `Named panel "${panelName}" must define at least one model.`);
	}
	if (!value.models.every((model) => typeof model === "string" && model.trim().length > 0)) {
		return invalidPanel(panelName, `Named panel "${panelName}" models must be non-empty strings.`);
	}
	if (value.judge !== undefined && (typeof value.judge !== "string" || value.judge.trim().length === 0)) {
		return invalidPanel(panelName, `Named panel "${panelName}" judge must be a non-empty string.`);
	}
	for (const key of ["panelReasoning", "judgeReasoning"] as const) {
		if (value[key] !== undefined && !isThinkingLevel(value[key])) {
			return invalidPanel(
				panelName,
				`Named panel "${panelName}" ${key} must be one of ${THINKING_LEVELS.join(", ")}.`,
			);
		}
	}

	return {
		ok: true,
		panel: {
			models: [...value.models] as string[],
			...(value.judge !== undefined ? { judge: value.judge as string } : {}),
			...(value.panelReasoning !== undefined ? { panelReasoning: value.panelReasoning as ThinkingLevel } : {}),
			...(value.judgeReasoning !== undefined ? { judgeReasoning: value.judgeReasoning as ThinkingLevel } : {}),
		},
	};
}

function applyNamedPanel(config: FusionConfig, panel: NamedPanelConfig): FusionConfig {
	return {
		...config,
		panel: [...panel.models],
		judge: panel.judge ?? config.judge,
		panelReasoning: panel.panelReasoning ?? config.panelReasoning,
		judgeReasoning: panel.judgeReasoning ?? config.judgeReasoning,
	};
}

function invalidPanel(
	panelName: string,
	message: string,
): { ok: false; error: ConfigSelectionError } {
	return {
		ok: false,
		error: { code: "invalid_named_panel", panelName, message },
	};
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function generateConfigExample(panel?: string[], judge?: string): FusionConfig {
	return {
		defaultPanel: "default",
		panels: {
			default: {
				models: panel ?? [
					"anthropic/claude-sonnet-4-5",
					"openai/gpt-4.1",
					"google/gemini-2.5-pro",
				],
				judge: judge ?? "anthropic/claude-opus-4-5",
				panelReasoning: "medium",
				judgeReasoning: "high",
			},
		},
		maxPanelModels: DEFAULT_MAX_PANEL_MODELS,
		maxPanelOutputTokens: DEFAULT_MAX_PANEL_OUTPUT_TOKENS,
		maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
		temperature: DEFAULT_TEMPERATURE,
		panelTools: "none",
		maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
		footerDisplay: "full",
	};
}
