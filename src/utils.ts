/**
 * General utilities for pi-fusion.
 */

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, cutting on a character
 * boundary (never leaving a broken multibyte char), and append `suffix` only
 * when truncation actually happened. Returns the original string unchanged when
 * it already fits.
 */
export function truncateToBytes(text: string, maxBytes: number, suffix = ""): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
	let end = buf.length;
	// Back up to the start of the last (possibly partial) character.
	let start = end - 1;
	while (start >= 0 && (buf[start] & 0xc0) === 0x80) start--; // skip continuation bytes
	if (start >= 0) {
		const lead = buf[start];
		const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
		if (start + expected > end) end = start; // last char was cut short → drop it
	}
	return buf.subarray(0, end).toString("utf8") + suffix;
}

export function extractJson<T>(text: string): T | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const attempts = [trimmed];
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fenced?.[1]) attempts.push(fenced[1].trim());

	// Prefer the last top-level object when the model adds prose before/after JSON.
	const objects = [...trimmed.matchAll(/\{[\s\S]*\}/g)].map((m) => m[0]);
	if (objects.length > 0) attempts.push(objects.at(-1)!);

	for (const candidate of attempts) {
		const parsed = tryParseJson<T>(candidate);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

function tryParseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		// Common judge slip: trailing commas before } or ].
		const relaxed = text.replace(/,\s*([}\]])/g, "$1");
		if (relaxed !== text) {
			try {
				return JSON.parse(relaxed) as T;
			} catch {
				// ignore
			}
		}
	}
	return undefined;
}
