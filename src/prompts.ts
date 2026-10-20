/**
 * System prompts and prompt utilities for pi-fusion.
 */

import { truncateToBytes } from "./utils.ts";

export const PANEL_SYSTEM_PROMPT = `You are an independent panelist in a multi-model deliberation.

Answer the user's question thoroughly and to the best of your ability. You do not have access to tools; rely on your training knowledge. Be concise but complete. Do not mention that you are part of a panel or refer to other models.`;

export const PANEL_SYSTEM_PROMPT_WITH_TOOLS = `You are an independent panelist in a multi-model deliberation.

Answer the user's question thoroughly and to the best of your ability. You have access to tools (e.g. reading files and searching the codebase) — use them to gather concrete evidence before answering when it helps, then write a complete final answer in text. Keep tool use focused; do not loop. Be concise but complete. Do not mention that you are part of a panel or refer to other models.`;

/**
 * Panel system prompt bound to the effective per-response output budget. The budget is a soft
 * target, not a claim of precise token accounting: the model should lead with a concise verdict
 * or direct answer, stay comfortably under the cap instead of padding, and still honor exact-format
 * instructions (e.g. reply with exactly "OK"). The same number is passed to the provider as its
 * maxTokens cap, so the instruction and the hard limit stay aligned.
 */
export function buildPanelSystemPrompt(maxOutputTokens: number, withTools: boolean): string {
	const base = withTools ? PANEL_SYSTEM_PROMPT_WITH_TOOLS : PANEL_SYSTEM_PROMPT;
	return `${base}

Output budget: this response is capped at roughly ${maxOutputTokens} output tokens. Depending on the provider, reasoning tokens may share this cap; reserve enough budget for visible answer text. Lead with a concise verdict or direct answer first, then include only the supporting detail that matters, and stop comfortably below the cap rather than filling it. If the user asks for an exact format or a specific short reply (for example, answer with exactly "OK"), return only that. Do not pad to use the budget, and do not claim to have counted tokens precisely.`;
}

export const JUDGE_SYSTEM_PROMPT = `You are a critical judge comparing responses from a panel of AI models.

Given a task and the panel responses, return ONLY a JSON object with exactly this shape and no markdown code fences:

{
  "consensus": ["Points all or most panel models agree on. Treat these as higher-confidence."],
  "contradictions": [
    {
      "topic": "What they disagree about",
      "stances": [
        {"model": "provider/id", "stance": "What this model said"}
      ]
    }
  ],
  "partial_coverage": [
    {"models": ["provider/id"], "point": "Point only some models covered"}
  ],
  "unique_insights": [
    {"model": "provider/id", "insight": "Something only one model raised"}
  ],
  "blind_spots": ["Topics none of the panel models addressed"]
}

Guidelines:
- Compare rather than merge. Do not average opinions.
- Treat agreement across models as higher-confidence consensus.
- Surface real contradictions; do not invent them.
- Preserve unique insights from individual models.
- Flag blind spots the panel missed entirely.
- Output valid JSON only.`;

export function truncateForJudge(text: string, maxBytes: number): string {
	return truncateToBytes(text, maxBytes, "\n\n[truncated for judge context window]");
}
