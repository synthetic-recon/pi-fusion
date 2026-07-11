/**
 * Model resolution and panel selection for pi-fusion.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_PANEL_MODELS, MAX_PANEL_MODELS_HARD_LIMIT } from "./config.ts";

export function modelDisplay(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function resolveModelIdentifier(registry: ModelRegistry, identifier: string): Model<Api> | undefined {
	const slash = identifier.indexOf("/");
	if (slash > 0) {
		const provider = identifier.slice(0, slash);
		const id = identifier.slice(slash + 1);
		return registry.find(provider, id);
	}
	// No provider prefix: search by exact id across all models.
	return registry.getAll().find((m) => m.id === identifier);
}

export function selectDiversePanel(available: Model<Api>[], max: number): Model<Api>[] {
	const textModels = available.filter((m) => m.input.includes("text"));
	if (textModels.length === 0) return [];

	const byProvider = new Map<string, Model<Api>[]>();
	for (const m of textModels) {
		const list = byProvider.get(m.provider) ?? [];
		list.push(m);
		byProvider.set(m.provider, list);
	}

	const providers = Array.from(byProvider.keys());
	const chosen: Model<Api>[] = [];
	let round = 0;
	while (chosen.length < max) {
		let addedThisRound = false;
		for (const provider of providers) {
			const list = byProvider.get(provider)!;
			const candidate = list[round];
			if (!candidate) continue;
			if (!chosen.some((c) => c.provider === candidate.provider && c.id === candidate.id)) {
				chosen.push(candidate);
				addedThisRound = true;
				if (chosen.length >= max) break;
			}
		}
		if (!addedThisRound) break;
		round++;
	}
	return chosen;
}

export interface ResolveOptions {
	/** Ordered user/config candidates. When present, replaces the legacy session/config fields below. */
	candidates?: ResolveCandidate[];
	/** Judge used only when resolution reaches auto/current fallback. */
	autoJudge?: string;
	/** Max size for auto-diverse selection when candidates are supplied. */
	autoMaxPanelModels?: number;
	/** Warnings produced by config normalization before model resolution. */
	warnings?: string[];
	sessionPanel?: string[];
	sessionJudge?: string;
	configPanel?: string[];
	configJudge?: string;
	configMaxPanelModels?: number;
	currentModel?: Model<Api>;
}

export type ResolveSource = "session" | "explicit" | "default" | "legacy" | "auto" | "current";

export interface ResolveCandidate {
	source: Exclude<ResolveSource, "auto" | "current">;
	panel: string[];
	judge?: string;
	maxPanelModels: number;
	profileName?: string;
	/** Fail closed when no candidate model is authenticated. */
	strict?: boolean;
}

export interface ResolveResult {
	panel: Model<Api>[];
	judge: Model<Api>;
	warnings: string[];
	source: ResolveSource;
	profileName?: string;
}

export class PanelSelectionError extends Error {
	constructor(
		public readonly profileName: string | undefined,
		public readonly warnings: string[],
		message: string,
	) {
		super(message);
		this.name = "PanelSelectionError";
	}
}

function resolvePanelIdentifiers(
	registry: ModelRegistry,
	identifiers: string[],
	maxPanel: number,
	warnings: string[],
): Model<Api>[] {
	const panel: Model<Api>[] = [];
	for (const id of identifiers) {
		const resolved = resolveModelIdentifier(registry, id);
		if (!resolved) {
			warnings.push(`Unknown model identifier: ${id}`);
			continue;
		}
		if (!registry.hasConfiguredAuth(resolved)) {
			warnings.push(`Model not authed: ${modelDisplay(resolved)}`);
			continue;
		}
		if (!panel.some((m) => m.provider === resolved.provider && m.id === resolved.id)) {
			panel.push(resolved);
		}
		if (panel.length >= maxPanel) break;
	}
	return panel;
}

export async function resolvePanelAndJudge(
	registry: ModelRegistry,
	options: ResolveOptions,
): Promise<ResolveResult> {
	const warnings: string[] = [...(options.warnings ?? [])];
	const configuredMaxPanel = Math.min(
		options.autoMaxPanelModels ?? options.configMaxPanelModels ?? DEFAULT_MAX_PANEL_MODELS,
		MAX_PANEL_MODELS_HARD_LIMIT,
	);
	const candidates = options.candidates ?? legacyResolveCandidates(options, configuredMaxPanel);

	let panel: Model<Api>[] = [];
	let selected: ResolveCandidate | undefined;
	for (const candidate of candidates) {
		if (candidate.panel.length === 0) continue;
		const maxPanel = Math.min(candidate.maxPanelModels, MAX_PANEL_MODELS_HARD_LIMIT);
		panel = resolvePanelIdentifiers(registry, candidate.panel, maxPanel, warnings);
		if (panel.length > 0) {
			selected = candidate;
			break;
		}

		const label = candidate.profileName
			? `Named panel "${candidate.profileName}"`
			: candidate.source === "session"
				? "Session panel"
				: "Legacy panel";
		const message = `${label} contained no authed models.`;
		warnings.push(candidate.strict ? message : `${message} Trying the next configured candidate.`);
		if (candidate.strict) {
			throw new PanelSelectionError(candidate.profileName, warnings, message);
		}
	}

	let source: ResolveSource;
	if (selected) {
		source = selected.source;
	} else {
		panel = selectDiversePanel(registry.getAvailable(), configuredMaxPanel);
		source = "auto";
	}

	// Final fallback to current model.
	if (panel.length === 0 && options.currentModel && registry.hasConfiguredAuth(options.currentModel)) {
		panel = [options.currentModel];
		source = "current";
	}

	if (panel.length === 0) {
		throw new Error("No authed models available for the fusion panel. Configure models in ~/.pi/agent/fusion.json or authenticate more providers.");
	}

	// The judge belongs to the candidate that actually supplied the panel. A judge
	// from a failed named candidate must never leak into legacy/auto fallback.
	let judge: Model<Api> | undefined;
	const selectedJudge = selected?.judge ?? (
		selected?.source === "session"
			? options.autoJudge ?? options.configJudge
			: selected
				? undefined
				: options.autoJudge ?? options.configJudge
	);
	for (const candidateId of [selectedJudge]) {
		if (judge || !candidateId) continue;
		const resolved = resolveModelIdentifier(registry, candidateId);
		if (!resolved) {
			warnings.push(`Unknown judge identifier: ${candidateId}`);
		} else if (!registry.hasConfiguredAuth(resolved)) {
			warnings.push(`Judge model not authed: ${modelDisplay(resolved)}`);
		} else {
			judge = resolved;
		}
	}

	if (!judge && options.currentModel && registry.hasConfiguredAuth(options.currentModel)) {
		judge = options.currentModel;
	}

	if (!judge) {
		judge = panel[0];
	}

	return {
		panel,
		judge,
		warnings,
		source,
		...(selected?.profileName ? { profileName: selected.profileName } : {}),
	};
}

/** Preserve the public resolver's original session -> config -> auto behavior. */
function legacyResolveCandidates(options: ResolveOptions, configuredMaxPanel: number): ResolveCandidate[] {
	const candidates: ResolveCandidate[] = [];
	if (options.sessionPanel?.length) {
		candidates.push({
			source: "session",
			panel: options.sessionPanel,
			judge: options.sessionJudge,
			maxPanelModels: MAX_PANEL_MODELS_HARD_LIMIT,
		});
	}
	if (options.configPanel?.length) {
		candidates.push({
			source: "legacy",
			panel: options.configPanel,
			judge: options.configJudge,
			maxPanelModels: configuredMaxPanel,
		});
	}
	return candidates;
}
