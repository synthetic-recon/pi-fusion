/**
 * Shared types for pi-fusion.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export type { Api, Model };

/** Named panel tool bundles, or an explicit list of tool names. */
export type ToolMode = "none" | "readonly" | "all";
export type ToolSelection = ToolMode | string[];

export interface FusionConfig {
	/** Explicit panel model identifiers, e.g. ["anthropic/claude-sonnet-4-5"]. */
	panel?: string[];
	/** Explicit judge model identifier. */
	judge?: string;
	/** Max panel models (1–8). */
	maxPanelModels?: number;
	/** Max tokens per panel response. */
	maxPanelOutputTokens?: number;
	/** Max tokens for the judge analysis. */
	maxCompletionTokens?: number;
	/** Sampling temperature for panel and judge. */
	temperature?: number;
	/** Panel tool access: "none" (default), "readonly", "all", or an explicit tool-name list. */
	panelTools?: ToolSelection;
	/** Max tool-call steps per panel model (1–100, default 16). */
	maxToolCalls?: number;
	/** Non-interactive consent for mutating tools (bash/edit/write) — required in print/no-UI mode. */
	panelToolsConsent?: boolean;
}

/** A FusionConfig after `applyDefaults`: the numeric knobs are guaranteed present. */
export type ResolvedFusionConfig = FusionConfig & {
	maxPanelModels: number;
	maxPanelOutputTokens: number;
	maxCompletionTokens: number;
	temperature: number;
	maxToolCalls: number;
};

export interface PanelResult {
	model: string;
	provider: string;
	id: string;
	content: string;
	error?: string;
	tools?: PanelToolUsage;
}

export interface FusionAnalysis {
	consensus: string[];
	contradictions: Array<{ topic: string; stances: Array<{ model: string; stance: string }> }>;
	partial_coverage: Array<{ models: string[]; point: string }>;
	unique_insights: Array<{ model: string; insight: string }>;
	blind_spots: string[];
}

export interface FusionOptions {
	analysis_models?: string[];
	/** OpenRouter-compatible judge parameter name. */
	model?: string;
	/** Backward-compatible alias for model. */
	judge_model?: string;
	max_completion_tokens?: number;
	temperature?: number;
	/** Per-call panel tool mode (enum only; the explicit-list form is config-file only). */
	panel_tools?: ToolMode;
	/** Per-call max tool-call steps per panel model (1–100). */
	max_tool_calls?: number;
	/** Internal/context-expanded text built by the extension from session history. */
	context_text?: string;
}

/** Per-panel-response tool-loop metadata, surfaced in diagnostics. */
export interface PanelToolUsage {
	turns: number;
	tool_calls: Array<{ name: string; ok: boolean }>;
	capped: boolean;
}

export interface FusionResult {
	content: Array<{ type: "text"; text: string }>;
	details: FusionDetails;
}

export interface FusionDetails {
	/** OpenRouter-style status: ok if any useful panel response exists; error only for hard failure. */
	status: "ok" | "error";
	analysis?: FusionAnalysis;
	responses: Array<{ model: string; content: string; tools?: PanelToolUsage }>;
	failed_models?: Array<{ model: string; error: string; tools?: PanelToolUsage }>;
	panel_models?: string[];
	judge_model?: string;
	/** Resolved panel tool mode + cap, when tools were enabled. */
	panel_tools?: { mode: string; max_tool_calls: number; serialized: boolean };
	/** Non-fatal warnings (unauthed models, tool downgrades, etc.). */
	warnings?: string[];
	error?: string;
	failure_reason?: "all_panels_failed" | "insufficient_credits" | "rate_limited" | "unexpected_error";
}

