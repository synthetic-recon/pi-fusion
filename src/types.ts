/**
 * Shared types for pi-fusion.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export type { Api, Model };

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
}

export interface PanelResult {
	model: string;
	provider: string;
	id: string;
	content: string;
	error?: string;
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
	/** Internal/context-expanded text built by the extension from session history. */
	context_text?: string;
}

export interface FusionResult {
	content: Array<{ type: "text"; text: string }>;
	details: FusionDetails;
}

export interface FusionDetails {
	/** OpenRouter-style status: ok if any useful panel response exists; error only for hard failure. */
	status: "ok" | "error";
	analysis?: FusionAnalysis;
	responses: Array<{ model: string; content: string }>;
	failed_models?: Array<{ model: string; error: string }>;
	panel_models?: string[];
	judge_model?: string;
	error?: string;
	failure_reason?: "all_panels_failed" | "insufficient_credits" | "rate_limited" | "unexpected_error";
}

export interface ResolvedPanel {
	panel: Model<Api>[];
	judge: Model<Api>;
	warnings: string[];
}

export interface ConfigValidationResult {
	valid: boolean;
	config: FusionConfig;
	warnings: string[];
	errors: string[];
}
