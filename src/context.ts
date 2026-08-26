/**
 * Conversation-context helpers for optional fusion context.
 */

import { extractJson } from "./utils.ts";

const MAX_CONTEXT_TURNS = 10;
const DEFAULT_CONTEXT_TURNS = 4;
const MAX_CONTEXT_CHARS = 20000;

export type FusionContextMode = "none" | "recent";

/** Prior fusion-state, tool-result JSON, or assistant blobs that are fusion details. */
export function isFusionDumpText(text: string): boolean {
	const parsed = extractJson<Record<string, unknown>>(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	if (parsed.status !== "ok" && parsed.status !== "error") return false;
	return "responses" in parsed || "excerpts" in parsed || "analysis" in parsed || "panel_models" in parsed;
}

function isFusionDumpEntry(entry: { type?: unknown; customType?: unknown; message?: { role?: unknown; toolName?: unknown } }): boolean {
	if (entry.customType === "fusion-state") return true;
	const role = entry.message?.role;
	if (role === "toolResult" || role === "tool") return true;
	if (entry.message?.toolName === "fusion") return true;
	return false;
}

export function normalizeContextTurns(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONTEXT_TURNS;
	return Math.max(1, Math.min(MAX_CONTEXT_TURNS, Math.floor(value)));
}

export function extractMessageText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "type" in part && (part as { type?: unknown }).type === "text") {
				const text = (part as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			}
			return "";
		})
		.join("\n")
		.trim();
}

export function buildRecentContextFromEntries(entries: unknown[], turns: number | undefined): string | undefined {
	const maxTurns = normalizeContextTurns(turns);
	const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
	let userMessagesSeen = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; message?: { role?: unknown; toolName?: unknown } };
		if (isFusionDumpEntry(entry)) continue;
		if (entry?.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractMessageText(entry.message);
		if (!text || isFusionDumpText(text)) continue;
		messages.unshift({ role, text });
		if (role === "user") {
			userMessagesSeen++;
			if (userMessagesSeen >= maxTurns) break;
		}
	}

	if (messages.length === 0) return undefined;

	let rendered = messages
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
		.join("\n\n");

	if (rendered.length > MAX_CONTEXT_CHARS) {
		rendered = rendered.slice(rendered.length - MAX_CONTEXT_CHARS).trimStart();
		rendered = `[truncated to last ${MAX_CONTEXT_CHARS} chars]\n${rendered}`;
	}

	return rendered;
}

export function buildFusionTaskText(prompt: string, contextText: string | undefined): string {
	if (!contextText?.trim()) return prompt;
	return [
		"Recent conversation context:",
		contextText.trim(),
		"",
		"Current task:",
		prompt.trim(),
	].join("\n");
}
