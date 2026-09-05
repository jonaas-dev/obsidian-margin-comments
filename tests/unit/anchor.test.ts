import { describe, it, expect } from "vitest";
import { createAnchor, matchByHash, matchByContext, CONTEXT_LENGTH } from "../../src/anchor";

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
