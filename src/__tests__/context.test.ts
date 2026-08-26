/**
 * Tests for optional conversation context building.
 */

import { buildFusionTaskText, buildRecentContextFromEntries, normalizeContextTurns } from "../context.ts";
import { test } from "./_harness.ts";

function msg(role: "user" | "assistant" | "tool", text: string) {
	return {
		type: "message",
		message: {
			role,
			content: [{ type: "text", text }],
		},
	};
}

test("normalizeContextTurns defaults and clamps", () => {
	if (normalizeContextTurns(undefined) !== 4) throw new Error("expected default 4");
	if (normalizeContextTurns(0) !== 1) throw new Error("expected min 1");
	if (normalizeContextTurns(99) !== 10) throw new Error("expected max 10");
	if (normalizeContextTurns(2.9) !== 2) throw new Error("expected floor");
});

test("buildRecentContextFromEntries includes last N user turns with assistant replies", () => {
	const entries = [
		msg("user", "u1"),
		msg("assistant", "a1"),
		msg("user", "u2"),
		msg("assistant", "a2"),
		msg("user", "u3"),
	];
	const context = buildRecentContextFromEntries(entries, 2);
	if (!context) throw new Error("expected context");
	if (context.includes("u1")) throw new Error("did not expect oldest turn");
	if (!context.includes("User: u2")) throw new Error("expected u2");
	if (!context.includes("Assistant: a2")) throw new Error("expected a2");
	if (!context.includes("User: u3")) throw new Error("expected u3");
});

test("buildRecentContextFromEntries skips tool messages", () => {
	const entries = [msg("user", "u1"), msg("tool", "tool output"), msg("assistant", "a1")];
	const context = buildRecentContextFromEntries(entries, 1);
	if (!context) throw new Error("expected context");
	if (context.includes("tool output")) throw new Error("did not expect tool output");
});

test("buildRecentContextFromEntries skips prior fusion dumps", () => {
	const dump = JSON.stringify({
		status: "ok",
		analysis: { consensus: ["secret-consensus"], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] },
		responses: [{ model: "a/m", content: "full-panel-answer-should-not-rebroadcast" }],
		panel_models: ["a/m"],
	});
	const compactDump = JSON.stringify({
		status: "ok",
		excerpts: [{ model: "a/m", excerpt: "excerpt-should-not-rebroadcast" }],
		panel_models: ["a/m"],
	});
	const entries = [
		msg("user", "u1"),
		msg("assistant", dump),
		{
			type: "custom",
			customType: "fusion-state",
			data: { selectedIds: ["a/m"] },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "fusion",
				content: [{ type: "text", text: compactDump }],
			},
		},
		msg("user", "u2"),
		msg("assistant", "normal reply"),
	];
	const context = buildRecentContextFromEntries(entries, 2);
	if (!context) throw new Error("expected context");
	if (context.includes("secret-consensus")) throw new Error("did not expect analysis dump");
	if (context.includes("full-panel-answer-should-not-rebroadcast")) throw new Error("did not expect full panel dump");
	if (context.includes("excerpt-should-not-rebroadcast")) throw new Error("did not expect compact tool dump");
	if (context.includes("a/m")) throw new Error("did not expect fusion-state ids");
	if (!context.includes("User: u1") || !context.includes("User: u2")) throw new Error("expected real user turns");
	if (!context.includes("Assistant: normal reply")) throw new Error("expected non-dump assistant reply");
});

test("buildFusionTaskText wraps context and current task", () => {
	const task = buildFusionTaskText("Decide", "User: prior");
	if (!task.includes("Recent conversation context:")) throw new Error("missing context heading");
	if (!task.includes("Current task:\nDecide")) throw new Error("missing current task");
});
