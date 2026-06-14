/**
 * Model resolution and panel selection for pi-fusion.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { MAX_PANEL_MODELS_HARD_LIMIT } from "./config.ts";

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
	sessionPanel?: string[];
	sessionJudge?: string;
	configPanel?: string[];
	configJudge?: string;
	configMaxPanelModels?: number;
	currentModel?: Model<Api>;
}

export interface ResolveResult {
	panel: Model<Api>[];
	judge: Model<Api>;
	warnings: string[];
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
	const warnings: string[] = [];
	const maxPanel = Math.min(
		options.configMaxPanelModels ?? 3,
		MAX_PANEL_MODELS_HARD_LIMIT,
	);

	let panel: Model<Api>[] = [];

	// 1. Session selection has highest priority.
	if (options.sessionPanel && options.sessionPanel.length > 0) {
		panel = resolvePanelIdentifiers(registry, options.sessionPanel, maxPanel, warnings);
		if (panel.length === 0) {
			warnings.push("Session panel contained no authed models; falling back to config/auto-selection.");
		}
	}

	// 2. File config panel.
	if (panel.length === 0 && options.configPanel && options.configPanel.length > 0) {
		panel = resolvePanelIdentifiers(registry, options.configPanel, maxPanel, warnings);
		if (panel.length === 0) {
			warnings.push("Explicit panel contained no authed models; falling back to auto-selection.");
		}
	}

	// 3. Auto-diverse selection.
	if (panel.length === 0) {
		const available = registry.getAvailable();
		panel = selectDiversePanel(available, maxPanel);
	}

	// 4. Final fallback to current model.
	if (panel.length === 0 && options.currentModel && registry.hasConfiguredAuth(options.currentModel)) {
		panel = [options.currentModel];
	}

	if (panel.length === 0) {
		throw new Error("No authed models available for the fusion panel. Configure models in ~/.pi/agent/fusion.json or authenticate more providers.");
	}

	// Resolve judge: session > config > current model > first panel model.
	let judge: Model<Api> | undefined;

	for (const candidateId of [options.sessionJudge, options.configJudge]) {
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

	return { panel, judge, warnings };
}

export interface AuthedModelInfo {
	identifier: string;
	provider: string;
	id: string;
	name: string;
	selected: boolean;
}

export function listAuthedModels(registry: ModelRegistry, selectedIds?: Set<string>): AuthedModelInfo[] {
	const available = registry.getAvailable().filter((m) => m.input.includes("text"));
	return available
		.map((m) => ({
			identifier: modelDisplay(m),
			provider: m.provider,
			id: m.id,
			name: m.name,
			selected: selectedIds ? selectedIds.has(modelDisplay(m)) : false,
		}))
		.sort((a, b) => a.identifier.localeCompare(b.identifier));
}
