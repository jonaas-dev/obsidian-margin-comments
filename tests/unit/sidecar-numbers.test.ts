import { describe, expect, it } from "vitest";
import { createAnchor, matchAnchor, matchByFuzzy } from "../../src/anchor";
import { formatRelativeTime } from "../../src/ui/relative-time";
import type { TextAnchor } from "../../src/types";

// A sidecar is a file in the vault, and validation only asks that its numbers be
// finite (#345). These are the values a hand edit, a sync conflict or another
// plugin version can leave behind, which no anchor this plugin writes contains.
const HOSTILE = [-1e308, -1000, -41, -1, -0, 0, 0.5, 10.5, 100.5, Number.MAX_SAFE_INTEGER, 1e308];

/** Seeded, so a failure names a case that can be replayed. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ["alpha", "beta", "gamma", "delta", "río", "café", "", "x", "fox jumps"];

function note(next: () => number): string {
	const lines = Array.from({ length: 1 + Math.floor(next() * 150) }, () =>
		Array.from(
			{ length: Math.floor(next() * 6) },
			() => WORDS[Math.floor(next() * WORDS.length)],
		).join(" "),
	);
	return lines.join("\n");
}

const pick = <T>(next: () => number, from: readonly T[]): T =>
	from[Math.floor(next() * from.length)];

describe("an anchor carrying numbers no plugin wrote (#345)", () => {
	it("never matches outside the note, whatever the numbers", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const next = random(seed);
			const written = note(next);
			const a = Math.floor(next() * (written.length + 1));
			const b = Math.floor(next() * (written.length + 1));
			const anchor: TextAnchor = {
				...createAnchor(written, Math.min(a, b), Math.max(a, b)),
				lineHint: pick(next, HOSTILE),
				startOffset: pick(next, HOSTILE),
				endOffset: pick(next, HOSTILE),
			};
			// Read against a different note as often as the same one, so the
			// fuzzy stage and the orphan path both get exercised.
			const read = next() < 0.5 ? written : note(next);
			const match = matchAnchor(read, anchor, { fuzzy: true, threshold: 0.3 });
			if (match === null) continue;
			expect({
				seed,
				ok: 0 <= match.from && match.from <= match.to && match.to <= read.length,
			}).toEqual({
				seed,
				ok: true,
			});
		}
	});

	it("ignores the stored offsets, which nothing reads", () => {
		// startOffset and endOffset are written and never read back: the match is
		// the same whatever they say, so bounding them at validation would reject
		// comments for a field with no effect.
		for (let seed = 1; seed <= 100; seed++) {
			const next = random(seed);
			const text = note(next);
			const from = Math.floor(next() * (text.length + 1));
			const anchor = createAnchor(text, from, from + Math.floor(next() * 20));
			const hostile = {
				...anchor,
				startOffset: pick(next, HOSTILE),
				endOffset: pick(next, HOSTILE),
			};
			expect(matchAnchor(text, hostile, { fuzzy: true })).toEqual(
				matchAnchor(text, anchor, { fuzzy: true }),
			);
		}
	});

	describe("a line hint that cannot be a line still bounds the fuzzy search", () => {
		const text = "The quick brown fox jumps over the lazy dog near the river bank today";
		const nearMatch = "The quick brown fox jumped over a lazy dog near the river bank today";
		const withNearMatchOn = (line: number): string => {
			const body = Array.from({ length: 300 }, (_, i) => `filler ${i}`);
			body[line - 1] = nearMatch;
			return body.join("\n");
		};
		const anchor = createAnchor(text, 0, text.length);

		it.each([-100, -1e308])(
			"a hint of %d searches near the top, not the whole note",
			(lineHint) => {
				// Below -40 the window's last line came before line 1, was never
				// reached, and the window ran to the end of the note: the #262 failure
				// by another route.
				expect(matchByFuzzy(withNearMatchOn(200), { ...anchor, lineHint }, 0.3)).toBeNull();
				expect(
					matchByFuzzy(withNearMatchOn(20), { ...anchor, lineHint }, 0.3),
				).not.toBeNull();
			},
		);

		it("a fractional hint near the top does not open the window to the end", () => {
			expect(
				matchByFuzzy(withNearMatchOn(200), { ...anchor, lineHint: 10.5 }, 0.3),
			).toBeNull();
		});

		it("a fractional hint further down still searches around it", () => {
			// The line counter is an integer, so a fractional first line was never
			// reached either, and the window came out empty.
			expect(
				matchByFuzzy(withNearMatchOn(100), { ...anchor, lineHint: 100.5 }, 0.3),
			).not.toBeNull();
		});
	});

	it("draws any finite timestamp as text, without throwing", () => {
		for (const timestamp of HOSTILE) {
			expect(typeof formatRelativeTime(timestamp, 1_700_000_000_000)).toBe("string");
		}
	});
});
