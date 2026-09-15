import { describe, it, expect } from "vitest";
import {
	createAnchor,
	matchAnchor,
	matchByHash,
	matchByContext,
	matchByFuzzy,
	CONTEXT_LENGTH,
	FUZZY_WINDOW_LINES,
} from "../../src/anchor";

const doc = ["first line", "second line with target text here", "third line"].join("\n");
const targetFrom = doc.indexOf("target text");
const targetTo = targetFrom + "target text".length;

describe("createAnchor", () => {
	it("captures the selected text", () => {
		expect(createAnchor(doc, targetFrom, targetTo).selectedText).toBe("target text");
	});

	it("records the line the selection started on, 1-based", () => {
		expect(createAnchor(doc, targetFrom, targetTo).lineHint).toBe(2);
	});

	it("captures context on both sides", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		expect(anchor.contextBefore.endsWith("second line with ")).toBe(true);
		expect(anchor.contextAfter.startsWith(" here")).toBe(true);
	});

	it("caps context at CONTEXT_LENGTH characters", () => {
		const long = `${"a".repeat(500)}TARGET${"b".repeat(500)}`;
		const anchor = createAnchor(long, 500, 506);
		expect(anchor.contextBefore).toHaveLength(CONTEXT_LENGTH);
		expect(anchor.contextAfter).toHaveLength(CONTEXT_LENGTH);
	});

	it("treats an empty selection as a line comment anchored to the trimmed line", () => {
		const anchor = createAnchor(doc, targetFrom, targetFrom);
		expect(anchor.isLineComment).toBe(true);
		expect(anchor.selectedText).toBe("second line with target text here");
	});

	it("marks a non-empty selection as not a line comment", () => {
		expect(createAnchor(doc, targetFrom, targetTo).isLineComment).toBe(false);
	});
});

describe("matchByHash", () => {
	it("finds text that has not moved", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		expect(matchByHash(doc, anchor)).toMatchObject({ from: targetFrom, to: targetTo });
	});

	it("finds text after lines were inserted above it", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		const edited = `brand new line\nanother one\n${doc}`;
		const match = matchByHash(edited, anchor);
		expect(edited.slice(match!.from, match!.to)).toBe("target text");
	});

	it("finds text after the lines above it were deleted", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		const edited = "second line with target text here\nthird line";
		const match = matchByHash(edited, anchor);
		expect(edited.slice(match!.from, match!.to)).toBe("target text");
	});

	it("returns null when the text is gone", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		expect(matchByHash("nothing like the original\nat all", anchor)).toBeNull();
	});

	it("anchors to the occurrence nearest the line hint when text repeats", () => {
		const repeated = ["target text", "filler", "filler", "target text", "filler"].join("\n");
		const anchor = createAnchor(repeated, repeated.lastIndexOf("target text"), repeated.lastIndexOf("target text") + 11);
		const match = matchByHash(repeated, anchor);
		expect(match!.from).toBe(repeated.lastIndexOf("target text"));
	});

	it("picks the occurrence whose surroundings match, not the nearest line number", () => {
		// The line hint alone was wrong here: comment a repeated phrase, then
		// insert text *between* the two occurrences. The hint stays near the
		// decoy while the real one moves away, and the comment silently changes
		// what it is about.
		const original = [
			"Alpha section, see below for details.",
			"Beta section.",
			"Gamma section, see below for details.",
			"The end.",
		].join("\n");
		const at = original.lastIndexOf("see below");
		const repeated = createAnchor(original, at, at + "see below".length);

		const edited = [
			"Alpha section, see below for details.",
			"Beta section.",
			...Array.from({ length: 200 }, (_, i) => `inserted line ${i}`),
			"Gamma section, see below for details.",
			"The end.",
		].join("\n");

		const match = matchByHash(edited, repeated)!;
		expect(edited.slice(match.from - 15, match.from)).toBe("Gamma section, ");
	});

	it("still follows text inserted above both occurrences", () => {
		// The case the line hint always handled, kept: both moved by the same
		// amount, so their order is intact and either rule agrees.
		const original = ["Intro.", "One, see below.", "Two.", "Other, see below.", "End."].join("\n");
		const at = original.indexOf("see below");
		const repeated = createAnchor(original, at, at + "see below".length);

		const edited = [
			...Array.from({ length: 200 }, (_, i) => `inserted ${i}`),
			"Intro.",
			"One, see below.",
			"Two.",
			"Other, see below.",
			"End.",
		].join("\n");

		const match = matchByHash(edited, repeated)!;
		expect(edited.slice(match.from - 5, match.from)).toBe("One, ");
	});

	it("uses the text after the anchor too, not only the text before it", () => {
		// Two candidates with the same words before them and different words
		// after. Scoring one side only leaves them tied, and the tie-break then
		// hands it to whichever is nearer the stale hint — the decoy.
		const runs = (letter: string) => letter.repeat(60);
		const decoy = `${runs("x")}target${runs("z")}`;
		const real = `${runs("x")}target${runs("y")}`;

		const original = [decoy, "filler", real].join("\n");
		const at = original.lastIndexOf("target");
		const repeated = createAnchor(original, at, at + "target".length);

		const edited = [
			decoy,
			"filler",
			...Array.from({ length: 200 }, (_, i) => `inserted ${i}`),
			real,
		].join("\n");

		const match = matchByHash(edited, repeated)!;
		expect(edited.slice(match.to, match.to + 3)).toBe("yyy");
	});

	it("falls back to the line hint when the surroundings really are identical", () => {
		// Sixty characters of the same filler either side, so the stored context
		// — fifty at most — cannot tell the two apart at all. The hint is the
		// only thing left, and without it this becomes whichever the scan met
		// last.
		const line = `${"x".repeat(60)}target${"y".repeat(60)}`;
		const doc = [line, line].join("\n");
		const first = doc.indexOf("target");
		const repeated = createAnchor(doc, first, first + "target".length);
		expect(repeated.lineHint).toBe(1);

		const match = matchByHash(doc, repeated)!;
		expect(doc.slice(0, match.from).split("\n").length).toBe(1);
	});
	it("matches a line comment against the whole line", () => {
		const anchor = createAnchor(doc, targetFrom, targetFrom);
		const match = matchByHash(doc, anchor);
		expect(doc.slice(match!.from, match!.to)).toBe("second line with target text here");
	});

	it("reports which stage produced the match", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		expect(matchByHash(doc, anchor)!.method).toBe("hash");
	});

	it("rejects an anchor whose hash disagrees with its text", () => {
		// A hand-edited or half-synced sidecar can carry a stale hash. Trusting the
		// text alone would anchor the comment somewhere its author never put it.
		const anchor = { ...createAnchor(doc, targetFrom, targetTo), textHash: "0000000000000000" };
		expect(matchByHash(doc, anchor)).toBeNull();
	});
});

describe("matchByContext", () => {
	const original = "intro paragraph here\nthe quick brown fox jumps\noutro paragraph here";
	const from = original.indexOf("quick brown fox");
	const anchor = createAnchor(original, from, from + "quick brown fox".length);

	it("finds the text after a typo was fixed inside it", () => {
		const edited = original.replace("quick brown fox", "quik brown fox");
		const match = matchByContext(edited, anchor);
		expect(edited.slice(match!.from, match!.to)).toBe("quik brown fox");
	});

	it("finds the text after a word was inserted inside it", () => {
		const edited = original.replace("quick brown fox", "quick and brown fox");
		const match = matchByContext(edited, anchor);
		expect(edited.slice(match!.from, match!.to)).toBe("quick and brown fox");
	});

	it("finds the text after the whole section moved with its context intact", () => {
		const edited = `a new opening line\n${original}`;
		const match = matchByContext(edited, anchor);
		expect(edited.slice(match!.from, match!.to)).toBe("quick brown fox");
	});

	it("returns null when the surrounding context is gone too", () => {
		expect(matchByContext("completely different content entirely", anchor)).toBeNull();
	});

	it("reports which stage produced the match", () => {
		const edited = original.replace("quick brown fox", "quik brown fox");
		expect(matchByContext(edited, anchor)!.method).toBe("context");
	});

	it("requires both sides of the context, not just one", () => {
		// Only contextBefore survives here. Anchoring on half the evidence would
		// place the comment on whatever happens to follow, which is worse than
		// admitting the anchor is lost.
		const edited = "intro paragraph here\nsomething else entirely and unrelated";
		expect(matchByContext(edited, anchor)).toBeNull();
	});
});

describe("matchByFuzzy", () => {
	const sentence = "the quick brown fox jumps over the lazy dog";
	const original = `intro line\n${sentence}\noutro line`;
	const anchor = createAnchor(original, original.indexOf(sentence), original.indexOf(sentence) + sentence.length);

	it("finds text that picked up a few typos", () => {
		const edited = original.replace(sentence, "the qiuck brown fox jumps over the lasy dog");
		const match = matchByFuzzy(edited, anchor, 0.3);
		expect(edited.slice(match!.from, match!.to)).toBe("the qiuck brown fox jumps over the lasy dog");
	});

	it("finds text that lost a word", () => {
		const edited = original.replace(sentence, "the quick fox jumps over the lazy dog");
		expect(matchByFuzzy(edited, anchor, 0.3)).not.toBeNull();
	});

	it("does not match a sentence that was rewritten", () => {
		// The line this replaces it with is nothing like the original. Matching it
		// would attach the comment to text its author never saw.
		const edited = original.replace(sentence, "a totally unrelated remark about pricing");
		expect(matchByFuzzy(edited, anchor, 0.3)).toBeNull();
	});

	it("honours the threshold at its boundaries", () => {
		// Two edits in 43 characters: inside 0.3, outside 0.02.
		const edited = original.replace(sentence, "the qiuck brown fox jumps over the lasy dog");
		expect(matchByFuzzy(edited, anchor, 0.3)).not.toBeNull();
		expect(matchByFuzzy(edited, anchor, 0.02)).toBeNull();
	});

	it("reports which stage produced the match", () => {
		const edited = original.replace(sentence, "the qiuck brown fox jumps over the lazy dog");
		expect(matchByFuzzy(edited, anchor, 0.3)!.method).toBe("fuzzy");
	});

	it("does not search the whole note for a near-match", () => {
		// A near-match far from where the comment lived is somebody else's text.
		// Bounding the window is also what keeps this stage affordable.
		const far = [
			"intro line",
			...Array.from({ length: FUZZY_WINDOW_LINES * 3 }, (_, i) => `filler line ${i}`),
			"the qiuck brown fox jumps over the lasy dog",
		].join("\n");
		expect(matchByFuzzy(far, anchor, 0.3)).toBeNull();
	});

	it("searches a short note end to end", () => {
		// With nothing to bound, the window is the note: a comment near the top of
		// a ten-line note must still find its text after the note is reshuffled.
		const shuffled = ["outro line", "unrelated", "the qiuck brown fox jumps over the lasy dog"].join("\n");
		expect(matchByFuzzy(shuffled, anchor, 0.3)).not.toBeNull();
	});

	describe("once the note is shorter than the comment's last known line (#262)", () => {
		const text = "The quick brown fox jumps over the lazy dog near the river bank today";
		const nearMatch = "The quick brown fox jumped over a lazy dog near the river bank today";
		const lines = (count: number): string[] => Array.from({ length: count }, (_, i) => `filler ${i}`);
		const long = [...lines(899), text, ...lines(100)].join("\n");
		const at900 = createAnchor(long, long.indexOf(text), long.indexOf(text) + text.length);
		/** A note of `count` lines holding the near-match on line `line`. */
		const noteWith = (count: number, line: number): string => {
			const body = lines(count);
			body[line - 1] = nearMatch;
			return body.join("\n");
		};

		it("finds no near-match 898 lines away in a note that still reaches the window", () => {
			expect(at900.lineHint).toBe(900);
			expect(matchByFuzzy(noteWith(950, 2), at900, 0.3)).toBeNull();
		});

		it("finds no near-match at the same distance in a note that ends before the window", () => {
			expect(matchByFuzzy(noteWith(100, 2), at900, 0.3)).toBeNull();
		});

		it("still searches the part of the window a note has left", () => {
			// Control: the window runs past the end of a 100-line note, and its lines
			// that remain are searched.
			const nearTheEnd = createAnchor(noteWith(100, 1).replace(nearMatch, text), 0, text.length);
			const hinted = { ...nearTheEnd, lineHint: 90 };
			expect(matchByFuzzy(noteWith(100, 95), hinted, 0.3)).not.toBeNull();
		});
	});

	it("abandons a long candidate instead of scoring it in full", () => {
		// A comment on a long paragraph, and a window full of long paragraphs that
		// are nothing like it. Each comparison has to give up as soon as the whole
		// band is past tolerance; scoring every one of them to the last row is a
		// hundred times the work, and this note is small.
		const paragraph = "lorem ipsum dolor sit amet consectetur ".repeat(100);
		const note = [
			paragraph,
			...Array.from({ length: 20 }, () => "completely unrelated wording throughout ".repeat(100)),
		].join("\n");
		const anchor = createAnchor(note, 0, paragraph.length);

		// A tight threshold is what makes the bail-out visible: the band is three
		// cells wide, so scoring to the last row is forty times the work. The
		// budget is loose enough for a shared runner and still an order of
		// magnitude below what scoring in full costs.
		const start = performance.now();
		expect(matchByFuzzy(note.slice(paragraph.length + 1), anchor, 0.02)).toBeNull();
		expect(performance.now() - start).toBeLessThan(250);
	});

	it("still finds a long paragraph that picked up a typo", () => {
		// The other half of the signature bound: cutting the comparison short must
		// not cost a match that a full comparison would have made.
		const paragraph = "lorem ipsum dolor sit amet consectetur ".repeat(100);
		const note = `heading line\n${paragraph}\ntrailing line`;
		const anchor = createAnchor(note, note.indexOf(paragraph), note.indexOf(paragraph) + paragraph.length);
		const edited = note.replace("lorem ipsum dolor", "lorem ispum dolor");

		expect(matchByFuzzy(edited, anchor, 0.1)).not.toBeNull();
	});

	it("has nothing to match when the anchor kept no text", () => {
		expect(matchByFuzzy(original, { ...anchor, selectedText: "" }, 0.3)).toBeNull();
	});
});

describe("matchAnchor", () => {
	const sentence = "the quick brown fox jumps over the lazy dog";
	const original = `intro line\n${sentence}\noutro line`;
	const anchor = createAnchor(original, original.indexOf(sentence), original.indexOf(sentence) + sentence.length);

	it("takes the exact match without running later stages", () => {
		expect(matchAnchor(original, anchor)!.method).toBe("hash");
	});

	it("falls back to context when the text changed", () => {
		const edited = original.replace(sentence, "the quick brown fox leaps over the lazy dog");
		expect(matchAnchor(edited, anchor)!.method).toBe("context");
	});

	it("reaches the fuzzy stage only when context is gone too", () => {
		const edited = `something else entirely\nthe qiuck brown fox jumps over the lasy dog\nand another thing`;
		expect(matchAnchor(edited, anchor, { fuzzy: true })!.method).toBe("fuzzy");
	});

	it("leaves the anchor lost when fuzzy matching is not asked for", () => {
		// The editor decorations re-run on every keystroke, so they stop at stage
		// 2; the panel, which redraws far less often, pays for stage 3.
		const edited = `something else entirely\nthe qiuck brown fox jumps over the lasy dog\nand another thing`;
		expect(matchAnchor(edited, anchor)).toBeNull();
	});
});

describe("performance", () => {
	// Re-anchoring runs on a debounce while typing, so a slow miss is felt as
	// editor lag. The budget is deliberately loose: it exists to catch an
	// accidental quadratic, not to police milliseconds on a shared CI runner.
	const BUDGET_MS = 250;
	const big = Array.from({ length: 10000 }, (_, i) => `line ${i} with some filler prose`).join("\n");
	const at = big.indexOf("line 5000");
	const anchor = createAnchor(big, at, at + 20);

	function timed(work: () => unknown): number {
		const start = performance.now();
		work();
		return performance.now() - start;
	}

	it("matches by hash on a 10,000 line note within budget", () => {
		expect(timed(() => matchByHash(big, anchor))).toBeLessThan(BUDGET_MS);
	});

	it("matches by context on a 10,000 line note within budget", () => {
		expect(timed(() => matchByContext(big, anchor))).toBeLessThan(BUDGET_MS);
	});

	it("stays linear when the context repeats throughout the note", () => {
		// The case that actually exercises the inner loop: when every position
		// clears the context bar, a missing early exit turns the scan quadratic.
		// The looser sample above cannot tell the two apart, because almost no
		// position passes the filter there.
		const repetitive = "the same filler sentence here.\n".repeat(3000);
		const repeated = createAnchor(repetitive, 100, 120);
		expect(timed(() => matchByContext(repetitive, repeated))).toBeLessThan(BUDGET_MS);
	});

	it("re-anchors 100 comments over a 10,000 line note within budget", () => {
		// The acceptance benchmark. The case that matters is context intact,
		// commented text rewritten: stage 1 misses and stage 2 has to work for its
		// answer. Scanning every offset took 139 seconds here — 1.4s per comment,
		// on a debounce, while typing.
		const REANCHOR_BUDGET_MS = 2000;
		const lines = Array.from({ length: 10000 }, (_, i) =>
			i % 100 === 0 ? `TARGET ${i} original sentence here` : `line ${i} with some filler prose here`,
		);
		const note = lines.join("\n");
		const anchors = Array.from({ length: 100 }, (_, i) => {
			const at = note.indexOf(`TARGET ${i * 100} `);
			return createAnchor(note, at, at + 30);
		});
		const edited = note.replace(/original sentence here/g, "rewritten words entirely");

		const elapsed = timed(() => {
			for (const anchor of anchors) matchAnchor(edited, anchor);
		});
		expect(elapsed).toBeLessThan(REANCHOR_BUDGET_MS);
	});

	it("re-anchors 100 comments through the fuzzy stage within budget", () => {
		// The panel's path, and the expensive one: every comment misses stages 1
		// and 2 and pays for a bounded fuzzy search before being called orphaned.
		const REANCHOR_BUDGET_MS = 2000;
		const lines = Array.from({ length: 10000 }, (_, i) =>
			i % 100 === 0
				? `TARGET ${i} the quick brown fox jumps over the lazy dog`
				: `line ${i} with some filler prose here`,
		);
		const note = lines.join("\n");
		const anchors = Array.from({ length: 100 }, (_, i) => {
			const at = note.indexOf(`TARGET ${i * 100} `);
			return createAnchor(note, at, at + 50);
		});
		// Text and context both rewritten, so nothing short of stage 3 can answer.
		const edited = note
			.replace(/the quick brown fox jumps over the lazy dog/g, "the qiuck brown fox jumps over the lasy dog")
			.replace(/filler prose here/g, "different words there");

		const methods: (string | undefined)[] = [];
		const elapsed = timed(() => {
			for (const anchor of anchors) methods.push(matchAnchor(edited, anchor, { fuzzy: true })?.method);
		});

		// Without this the benchmark would pass on a stage 3 that finds nothing:
		// giving up instantly is the fastest possible implementation.
		expect(methods.filter((method) => method === "fuzzy")).toHaveLength(100);
		expect(elapsed).toBeLessThan(REANCHOR_BUDGET_MS);
	});

	it("survives a context probe that repeats on every line", () => {
		// The shape that made the benchmark quadratic: the tail of an ordinary
		// sentence is a candidate on every line, so a per-candidate rescan of the
		// note is 10,000 scans deep.
		const note = Array.from({ length: 4000 }, (_, i) =>
			i === 2000 ? "TARGET original sentence here" : "line with some filler prose here",
		).join("\n");
		const at = note.indexOf("TARGET");
		const anchor = createAnchor(note, at, at + 30);
		const edited = note.replace("original sentence here", "rewritten words entirely");

		expect(timed(() => matchByContext(edited, anchor))).toBeLessThan(BUDGET_MS);
	});

	it("gives up on a context miss within budget", () => {
		// The worst case: nothing matches, so no early exit can help.
		const lost = {
			...anchor,
			contextBefore: "zzz nothing resembling this appears in the doc zz",
			contextAfter: "qqq nor does this fragment appear anywhere qqqqq",
		};
		expect(timed(() => matchByContext(big, lost))).toBeLessThan(BUDGET_MS);
	});
});

/**
 * The two constants the module's reasoning rests on, pinned by behaviour.
 *
 * Found by mutation: changing CONTEXT_MATCH_RATIO from 0.6 to 0.3, and the
 * fuzzy tolerance from Math.floor to Math.ceil, both left all 367 tests
 * passing. Neither is asserted directly here — asserting the number would pass
 * against any behaviour at all. Each case is built so that the *outcome* flips
 * if the constant moves, in either direction.
 */
describe("the constants stage 2 and stage 3 rest on", () => {
	function anchorWith(before: string, text: string, after: string) {
		return {
			selectedText: text,
			textHash: "unused-by-these-stages",
			isLineComment: false,
			contextBefore: before,
			contextAfter: after,
			lineHint: 1,
			startOffset: 0,
			endOffset: text.length,
		};
	}

	describe("CONTEXT_MATCH_RATIO", () => {
		// Twenty characters of context either side, so a surviving fraction is a
		// count. The half nearest the anchor is what a match must keep.
		const before = `${"A".repeat(6)}${"B".repeat(14)}`;
		const after = `${"C".repeat(14)}${"D".repeat(6)}`;

		it("accepts a candidate keeping 70% of its context", () => {
			// Above the 60% bar, so it must match. Raising the ratio to 0.8 makes
			// the probe longer than what survives, no candidate is found, and this
			// returns null.
			const doc = `${"Z".repeat(6)}${"B".repeat(14)}rewritten${"C".repeat(14)}${"E".repeat(6)}`;
			const match = matchByContext(doc, anchorWith(before, "original", after));

			expect(match).not.toBeNull();
			expect(doc.slice(match!.from, match!.to)).toBe("rewritten");
		});

		it("rejects a candidate keeping only half of it", () => {
			// Below the bar, so the anchor is lost rather than placed on text that
			// merely sits between two half-familiar neighbours. Lowering the ratio
			// to 0.3 accepts this and returns a match.
			const half = `${"A".repeat(10)}${"B".repeat(10)}`;
			const halfAfter = `${"C".repeat(10)}${"D".repeat(10)}`;
			const doc = `${"Z".repeat(10)}${"B".repeat(10)}rewritten${"C".repeat(10)}${"E".repeat(10)}`;

			expect(matchByContext(doc, anchorWith(half, "original", halfAfter))).toBeNull();
		});
	});

	describe("the fuzzy tolerance", () => {
		// Ten characters at 0.35 puts the tolerance at 3.5: floor allows three
		// edits, ceil allows four. Every other fuzzy test sits far enough from the
		// boundary that the rounding cannot change an outcome.
		const text = "abcdefghij";
		const anchor = anchorWith("", text, "");

		it("accepts a candidate exactly at the tolerance", () => {
			// Three edits, which floor(10 x 0.35) allows. Pins the bar as
			// inclusive: a strict comparison would reject this.
			const match = matchByFuzzy("abcdefgXYZ", anchor, 0.35);
			expect(match).not.toBeNull();
			expect(match!.from).toBe(0);
		});

		it("rejects a candidate one edit past it", () => {
			// Four edits. Rounding the tolerance up accepts this, and the comment
			// lands on text a character further from what was written.
			expect(matchByFuzzy("abcdefWXYZ", anchor, 0.35)).toBeNull();
		});
	});
});
