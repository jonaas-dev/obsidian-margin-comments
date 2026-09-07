import { describe, it, expect, vi } from "vitest";
import { createAnchor } from "../../src/anchor";

/**
 * matchAnchor, wrapped so its calls can be counted while it still does its real
 * work. Hoisted because vi.mock is: a plain const would not exist yet.
 */
const matchCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/anchor", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/anchor")>();
	return {
		...actual,
		matchAnchor: (...args: Parameters<typeof actual.matchAnchor>) => {
			matchCalls.count++;
			return actual.matchAnchor(...args);
		},
	};
});
import { resolveMarkers } from "../../src/editor/marker-pass";
import type { Comment } from "../../src/types";

function comment(doc: string, at: number, over = 20, extra: Partial<Comment> = {}): Comment {
	return {
		id: `c${at}`,
		filePath: "note.md",
		anchor: createAnchor(doc, at, at + over),
		content: "x",
		author: "",
		createdAt: 0,
		updatedAt: 0,
		resolved: false,
		parentId: null,
		...extra,
	};
}

describe("resolveMarkers", () => {
	const doc = "first line\nsecond line\nthird line\nfourth line";

	it("reports the line a comment resolves to, 1-based", () => {
		const at = doc.indexOf("third");
		expect([...resolveMarkers(doc, [comment(doc, at, 5)]).lines]).toEqual([3]);
	});

	it("finds the first and last lines, where an off-by-one would hide", () => {
		const first = comment(doc, 0, 5);
		const last = comment(doc, doc.indexOf("fourth"), 6);
		expect([...resolveMarkers(doc, [first, last]).lines].sort()).toEqual([1, 4]);
	});

	it("spans the whole line, not the commented words", () => {
		const at = doc.indexOf("second");
		const [range] = resolveMarkers(doc, [comment(doc, at, 6)]).ranges;
		expect(doc.slice(range.from, range.to)).toBe("second line");
	});

	it("runs the last line to the end of the document", () => {
		const [range] = resolveMarkers(doc, [comment(doc, doc.indexOf("fourth"), 6)]).ranges;
		expect(range.to).toBe(doc.length);
		expect(doc.slice(range.from, range.to)).toBe("fourth line");
	});

	it("returns one range per line however many comments share it", () => {
		const at = doc.indexOf("second");
		const pass = resolveMarkers(doc, [comment(doc, at, 6), comment(doc, at + 7, 4)]);
		// Two tints on one line stack into a darker band that reads as a state
		// nobody defined.
		expect(pass.ranges).toHaveLength(1);
	});

	it("returns ranges in document order, which CodeMirror requires", () => {
		const late = comment(doc, doc.indexOf("fourth"), 6);
		const early = comment(doc, 0, 5);
		const ranges = resolveMarkers(doc, [late, early]).ranges;
		expect(ranges.map((r) => r.from)).toEqual([0, doc.indexOf("fourth")]);
	});

	it("ignores resolved roots and replies", () => {
		const at = doc.indexOf("second");
		const resolved = comment(doc, at, 6, { resolved: true, id: "r" });
		const reply = comment(doc, at, 6, { parentId: "root", id: "p" });
		expect(resolveMarkers(doc, [resolved, reply]).lines.size).toBe(0);
	});

	it("follows a rewritten line by its surviving context", () => {
		// Stage 2's whole job. The text is gone but the lines either side are not,
		// so the comment belongs on the line that replaced it rather than nowhere.
		const at = doc.indexOf("second line");
		const anchored = comment(doc, at, 11);
		const rewritten = "first line\nsomething else entirely\nthird line\nfourth line";
		expect([...resolveMarkers(rewritten, [anchored]).lines]).toEqual([2]);
	});

	it("drops a comment whose text and context are both gone", () => {
		const at = doc.indexOf("second line");
		const anchored = comment(doc, at, 11);
		expect(
			resolveMarkers("nothing here resembles the original note", [anchored]).lines.size,
		).toBe(0);
	});
});

/**
 * The budget the editor path has to stay inside.
 *
 * This is the benchmark #31 asks for. It is deliberately a unit test rather
 * than a note in a document: a number nothing checks is a number that drifts.
 * The budget is loose on purpose — it exists to catch an accidental quadratic,
 * not to police milliseconds on a shared CI runner.
 */
describe("performance", () => {
	const BUDGET_MS = 250;
	const LINES = 10000;
	const COUNT = 200;
	const doc = Array.from(
		{ length: LINES },
		(_, i) => `line ${i} with some filler prose here`,
	).join("\n");
	const comments = Array.from({ length: COUNT }, (_, i) =>
		comment(doc, doc.indexOf(`line ${i * 37} `), 20),
	);

	function timed(work: () => unknown): number {
		const start = performance.now();
		work();
		return performance.now() - start;
	}

	it("anchors every comment it is given, so the budget measures real work", () => {
		// Without this, resolving nothing is the fastest implementation there is
		// and the budget below would applaud it.
		const pass = resolveMarkers(doc, comments);
		expect(pass.lines.size).toBe(COUNT);
		expect(pass.ranges).toHaveLength(COUNT);
	});

	it("resolves 200 comments on a 10,000-line note within budget", () => {
		expect(timed(() => resolveMarkers(doc, comments))).toBeLessThan(BUDGET_MS);
	});
});

/**
 * Why the guard below counts calls instead of milliseconds.
 *
 * Both the shape this replaced and its replacement are O(comments x document):
 * matchAnchor searches the note for every comment, so it dominates either way.
 * Resolving each line by counting newlines from the top of the note added a
 * constant factor, not a complexity class — measured at 68 ms against 19 ms for
 * 200 comments on 10,000 lines, and 529 ms against 220 ms at 500 on 50,000.
 * The gap *narrows* as the case grows, so the usual escape of enlarging the
 * case until the signal is unmistakable does not work here. A timing test tight
 * enough to separate 19 ms from 68 ms would be a coin toss on a shared runner.
 *
 * What can be asserted without a stopwatch is the thing that was actually
 * wrong: the same anchors were being resolved twice.
 */
describe("one match per comment", () => {
	it("resolves each open comment exactly once, however many consumers ask", () => {
		const doc = "alpha line\nbeta line\ngamma line";
		const open = [
			comment(doc, 0, 5),
			comment(doc, doc.indexOf("beta"), 4),
			comment(doc, doc.indexOf("gamma"), 5),
		];
		const ignored = [
			comment(doc, 0, 5, { id: "resolved", resolved: true }),
			comment(doc, 0, 5, { id: "reply", parentId: "root" }),
		];

		matchCalls.count = 0;
		const pass = resolveMarkers(doc, [...open, ...ignored]);

		// Both halves consumed, which is what the editor does with them.
		expect(pass.lines.size).toBe(3);
		expect(pass.ranges).toHaveLength(3);
		// Three open comments, three matches. Six would mean the gutter and the
		// highlights are each paying for the whole set; five would mean the
		// resolved root and the reply are being matched to be thrown away.
		expect(matchCalls.count).toBe(3);
	});
});
