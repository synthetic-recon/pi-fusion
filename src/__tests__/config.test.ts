/**
 * Tests for named-panel config selection and backward-compatible defaults.
 */

import {
	applyDefaults,
	generateConfigExample,
	parseFusionConfig,
	resolveEffectiveConfig,
} from "../config.ts";
import type { FusionConfig } from "../types.ts";
import { eq, test } from "./_harness.ts";

const namedConfig: FusionConfig = {
	panel: ["legacy/panel"],
	judge: "legacy/judge",
	panelReasoning: "low",
	judgeReasoning: "medium",
	defaultPanel: "quality",
	panels: {
		quality: {
			models: ["openai/gpt-5.5", "anthropic/claude-sonnet-5"],
			judge: "openai/gpt-5.5",
			panelReasoning: "high",
		},
		fast: {
			models: ["openai/gpt-5.4"],
			judgeReasoning: "minimal",
		},
	},
};

test("explicit named panel overrides the default and inherits omitted role settings", () => {
	const result = resolveEffectiveConfig(namedConfig, {}, "fast");
	if (!result.ok) throw new Error(result.error.message);

	eq(result.profileName, "fast", "explicit panel is identified");
	eq(result.source, "explicit", "selection source is explicit");
	eq(result.config.panel, ["openai/gpt-5.4"], "named models replace legacy panel");
	eq(result.config.judge, "legacy/judge", "omitted named judge inherits top-level judge");
	eq(result.config.panelReasoning, "low", "omitted panel reasoning inherits top-level effort");
	eq(result.config.judgeReasoning, "minimal", "named judge reasoning overrides top-level effort");
	eq(result.warnings, [], "valid explicit panel has no warnings");
});

test("defaultPanel selects a named panel and applies role overrides independently", () => {
	const result = resolveEffectiveConfig(namedConfig);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.profileName, "quality", "default panel is identified");
	eq(result.source, "default", "selection source is default");
	eq(result.config.panel, ["openai/gpt-5.5", "anthropic/claude-sonnet-5"], "default models selected");
	eq(result.config.judge, "openai/gpt-5.5", "default judge selected");
	eq(result.config.panelReasoning, "high", "named panel reasoning overrides top-level effort");
	eq(result.config.judgeReasoning, "medium", "omitted named judge effort inherits top-level effort");
});

test("legacy-only config remains unchanged apart from numeric defaults", () => {
	const legacy: FusionConfig = {
		panel: ["anthropic/claude-sonnet-4-5"],
		judge: "anthropic/claude-opus-4-5",
		maxPanelModels: 6,
		panelTools: "readonly",
	};
	const result = resolveEffectiveConfig(legacy);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.source, "legacy", "legacy source retained");
	eq(result.profileName, undefined, "legacy config has no profile name");
	eq(result.config.panel, legacy.panel, "legacy panel retained");
	eq(result.config.judge, legacy.judge, "legacy judge retained");
	eq(result.config.maxPanelModels, 6, "configured panel limit retained");
	eq(result.config.panelTools, "readonly", "unrelated config retained");
});

test("explicit unknown named panel returns a strict typed error", () => {
	const result = resolveEffectiveConfig(namedConfig, {}, "missing");
	if (result.ok) throw new Error("expected strict selection failure");

	eq(result.error.code, "unknown_named_panel", "unknown panel error code");
	eq(result.error.panelName, "missing", "unknown panel error identifies request");
	eq(result.warnings, [], "strict error does not downgrade to a warning");
});

test("explicit malformed or empty named panels return strict errors", () => {
	const config = {
		panels: {
			empty: { models: [] },
			malformed: { models: ["valid/model", 42] },
			badReasoning: { models: ["valid/model"], panelReasoning: "maximum" },
		},
	} as unknown as FusionConfig;

	for (const name of ["empty", "malformed", "badReasoning"]) {
		const result = resolveEffectiveConfig(config, {}, name);
		if (result.ok) throw new Error(`expected ${name} to fail`);
		eq(result.error.code, "invalid_named_panel", `${name} error code`);
		eq(result.error.panelName, name, `${name} error identifies request`);
	}
});

test("invalid configured default warns and falls through to legacy config", () => {
	const config: FusionConfig = {
		panel: ["legacy/panel"],
		judge: "legacy/judge",
		defaultPanel: "missing",
		panels: {},
	};
	const result = resolveEffectiveConfig(config);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.source, "legacy", "invalid default falls through");
	eq(result.config.panel, ["legacy/panel"], "legacy panel retained after invalid default");
	eq(result.config.judge, "legacy/judge", "legacy judge retained after invalid default");
	if (!result.warnings.some((warning) => warning.includes('defaultPanel "missing"'))) {
		throw new Error(`missing deterministic default warning: ${JSON.stringify(result.warnings)}`);
	}
});

test("invalid top-level reasoning is omitted with deterministic warnings", () => {
	const config = {
		panel: ["legacy/panel"],
		panelReasoning: "maximum",
		judgeReasoning: 3,
	} as unknown as FusionConfig;
	const result = resolveEffectiveConfig(config);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.config.panelReasoning, undefined, "invalid panel effort omitted");
	eq(result.config.judgeReasoning, undefined, "invalid judge effort omitted");
	eq(result.warnings.length, 2, "both invalid efforts warn");
});

test("effective selection preserves applyDefaults overrides and numeric config", () => {
	const result = resolveEffectiveConfig(
		{ ...namedConfig, maxPanelModels: 7 },
		{ max_completion_tokens: 8192, max_tool_calls: 25 },
		"quality",
	);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.config.maxPanelModels, 7, "configured max panel remains available");
	eq(result.config.maxCompletionTokens, 8192, "runtime numeric override retained");
	eq(result.config.maxToolCalls, 25, "runtime tool cap retained");
});

test("applyDefaults remains backward compatible when called directly", () => {
	const result = applyDefaults({ panel: ["legacy/panel"] }, {});
	eq(result.panel, ["legacy/panel"], "direct legacy use remains supported");
});

test("generated config uses a resolvable named default panel", () => {
	const example = generateConfigExample(["provider/panel"], "provider/judge");
	eq(example.defaultPanel, "default", "generated config names its default panel");
	eq(example.panels?.default.models, ["provider/panel"], "generated panel uses resolved models");
	eq(example.panels?.default.judge, "provider/judge", "generated panel uses resolved judge");
	const resolved = resolveEffectiveConfig(example);
	if (!resolved.ok) throw new Error(resolved.error.message);
	eq(resolved.profileName, "default", "generated config resolves through named-panel path");
});

test("config parser rejects non-object JSON roots", () => {
	for (const value of ["null", "[]", '"panel"']) {
		let error: unknown;
		try {
			parseFusionConfig(value);
		} catch (caught) {
			error = caught;
		}
		if (!(error instanceof Error) || !error.message.includes("JSON object")) {
			throw new Error(`expected object-root error for ${value}`);
		}
	}
});
