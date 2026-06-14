/**
 * Format fusion analysis and results for display.
 */

import type { FusionAnalysis, FusionDetails, PanelResult } from "./types.ts";

export function formatAnalysis(analysis: FusionAnalysis): string {
	const parts: string[] = [];

	if (analysis.consensus.length) {
		parts.push("## Consensus\n" + analysis.consensus.map((p) => `- ${p}`).join("\n"));
	}

	if (analysis.contradictions.length) {
		parts.push(
			"## Contradictions\n" +
				analysis.contradictions
					.map(
						(c) =>
							`- **${c.topic}**\n` +
							c.stances.map((s) => `  - ${s.model}: ${s.stance}`).join("\n"),
					)
					.join("\n"),
		);
	}

	if (analysis.partial_coverage.length) {
		parts.push(
			"## Partial Coverage\n" +
				analysis.partial_coverage.map((p) => `- [${p.models.join(", ")}] ${p.point}`).join("\n"),
		);
	}

	if (analysis.unique_insights.length) {
		parts.push(
			"## Unique Insights\n" +
				analysis.unique_insights.map((u) => `- ${u.model}: ${u.insight}`).join("\n"),
		);
	}

	if (analysis.blind_spots.length) {
		parts.push("## Blind Spots\n" + analysis.blind_spots.map((p) => `- ${p}`).join("\n"));
	}

	return parts.join("\n\n");
}

export function formatResult(
	analysis: FusionAnalysis | undefined,
	responses: PanelResult[],
	failed: PanelResult[],
	details: FusionDetails,
): string {
	const lines: string[] = [];
	lines.push(`# Fusion Analysis (${responses.length} panel model${responses.length === 1 ? "" : "s"})`);
	lines.push(`*Panel: ${(details.panel_models ?? []).join(", ")} | Judge: ${details.judge_model ?? "unknown"}*`);

	if (failed.length > 0) {
		lines.push(
			"\n**Failed models:** " + failed.map((f) => `${f.model} (${f.error})`).join("; "),
		);
	}

	if (responses.length < 2) {
		lines.push(
			"\n*Only one panel model produced a response. Skipping multi-model synthesis; see the raw response below.*",
		);
	} else if (analysis) {
		lines.push("\n" + formatAnalysis(analysis));
	} else {
		lines.push("\n*Judge analysis unavailable. See raw panel responses below.*");
	}

	lines.push("\n## Panel Responses");
	for (const r of responses) {
		lines.push(`\n### ${r.model}\n${r.content}`);
	}

	return lines.join("\n");
}

export function formatPreview(
	panel: Array<{ provider: string; id: string; name: string }>,
	judge: { provider: string; id: string; name: string },
	warnings: string[],
): string {
	const lines: string[] = [];
	lines.push("## Fusion Panel");
	for (const [i, m] of panel.entries()) {
		lines.push(`${i + 1}. ${m.provider}/${m.id} — ${m.name}`);
	}
	lines.push("");
	lines.push(`## Judge\n${judge.provider}/${judge.id} — ${judge.name}`);
	if (warnings.length > 0) {
		lines.push("");
		lines.push("## Warnings");
		for (const w of warnings) {
			lines.push(`- ${w}`);
		}
	}
	return lines.join("\n");
}
