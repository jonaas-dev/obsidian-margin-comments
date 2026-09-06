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

	it("flags an ambiguous match when the text appears more than once", () => {
		const repeated = "target text\nfiller\ntarget text";
		const anchor = createAnchor(repeated, 0, 11);
		expect(matchByHash(repeated, anchor)!.ambiguous).toBe(true);
	});

	it("does not flag a unique match as ambiguous", () => {
		const anchor = createAnchor(doc, targetFrom, targetTo);
		expect(matchByHash(doc, anchor)!.ambiguous).toBe(false);
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
