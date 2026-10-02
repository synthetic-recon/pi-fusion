/**
 * Tests for pi-fusion utilities.
 */

import { extractJson, mapWithConcurrencyLimit, stripTrailingCommas, truncateToBytes } from "../utils.ts";
import { eq, test } from "./_harness.ts";

test("extractJson parses plain JSON", () => {
	const result = extractJson<{ ok: boolean }>('{"ok":true}');
	if (result?.ok !== true) throw new Error("expected ok=true");
});

test("extractJson parses fenced JSON", () => {
	const result = extractJson<{ ok: boolean }>("```json\n{\"ok\":true}\n```");
	if (result?.ok !== true) throw new Error("expected ok=true from fence");
});

test("extractJson returns undefined for invalid text", () => {
	const result = extractJson<{ ok: boolean }>("not json");
	if (result !== undefined) throw new Error("expected undefined");
});

test("extractJson repairs object and array trailing commas", () => {
	eq(extractJson('{"a":1,}'), { a: 1 }, "object trailing comma");
	eq(extractJson('{"a":[1,2,\n],\n}'), { a: [1, 2] }, "array and object trailing commas with whitespace");
	eq(extractJson('Here you go:\n{"consensus":["x"],}\nThanks!'), { consensus: ["x"] }, "prose around repaired JSON");
});

test("extractJson trailing-comma repair preserves string contents", () => {
	eq(
		extractJson('{"consensus":["Keep literal ,} text", "and ,] too"],}'),
		{ consensus: ["Keep literal ,} text", "and ,] too"] },
		"delimiter text inside strings is untouched",
	);
	eq(
		extractJson('{"q":"say \\",}\\" and \\\\",}'),
		{ q: 'say ",}" and \\' },
		"escaped quotes and backslashes do not end the string early",
	);
	eq(stripTrailingCommas('{"a":"x, }"}'), '{"a":"x, }"}', "valid JSON with comma text in a string is unchanged");
});

test("mapWithConcurrencyLimit runs all tasks", async () => {
	const inputs = [1, 2, 3, 4, 5];
	const results = await mapWithConcurrencyLimit(inputs, 2, async (n) => n * 2);
	if (results.join(",") !== "2,4,6,8,10") throw new Error(`unexpected results: ${results}`);
});

test("mapWithConcurrencyLimit handles empty input", async () => {
	const results = await mapWithConcurrencyLimit<number, number>([], 2, async (n) => n);
	if (results.length !== 0) throw new Error("expected empty results");
});

test("truncateToBytes returns input unchanged when within budget", () => {
	if (truncateToBytes("hello", 100) !== "hello") throw new Error("should be unchanged");
});

test("truncateToBytes cuts to the byte budget and appends the suffix", () => {
	const out = truncateToBytes("abcdefghij", 4, "…");
	if (out !== "abcd…") throw new Error(`unexpected: ${out}`);
});

test("truncateToBytes never splits a multibyte char", () => {
	// "€" is 3 UTF-8 bytes. With a 4-byte budget only one full € fits; the second is dropped.
	const out = truncateToBytes("€€€", 4, "");
	if (out !== "€") throw new Error(`unexpected: ${out}`);
	if (out.includes("�")) throw new Error("produced a broken/replacement char");
	if (Buffer.byteLength(out, "utf8") > 4) throw new Error("exceeded byte budget");
});
