/**
 * Shared test harness for pi-fusion unit tests (no external runner).
 * Not a `*.test.ts` file, so the test glob does not execute it standalone.
 */

import type { Api, Model } from "../types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function test(name: string, fn: () => void | Promise<void>) {
	try {
		Promise.resolve(fn()).then(
			() => console.log(`✓ ${name}`),
			(err) => {
				console.error(`✗ ${name}:`, err);
				process.exitCode = 1;
			},
		);
	} catch (err) {
		// Catch synchronous throws too, so a broken setup fails the suite rather than the process.
		console.error(`✗ ${name}:`, err);
		process.exitCode = 1;
	}
}

export function eq<T>(a: T, b: T, msg: string) {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
	}
}

/**
 * Run a body with an isolated, empty agent config dir so tests never pick up the
 * developer's real ~/.pi/agent/fusion.json (which would make footer assertions machine-specific).
 */
export async function withEmptyAgentDir<T>(fn: () => T | Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-fusion-agent-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

export function fakeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	};
}
