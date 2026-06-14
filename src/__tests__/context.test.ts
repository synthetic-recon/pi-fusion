/**
 * Tests for optional conversation context building.
 */

import { buildFusionTaskText, buildRecentContextFromEntries, normalizeContextTurns } from "../context.ts";

function test(name: string, fn: () => void | Promise<void>) {
	Promise.resolve(fn()).then(
		() => console.log(`✓ ${name}`),
		(err) => {
			console.error(`✗ ${name}:`, err);
			process.exitCode = 1;
		},
	);
}

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

test("buildFusionTaskText wraps context and current task", () => {
	const task = buildFusionTaskText("Decide", "User: prior");
	if (!task.includes("Recent conversation context:")) throw new Error("missing context heading");
	if (!task.includes("Current task:\nDecide")) throw new Error("missing current task");
});
