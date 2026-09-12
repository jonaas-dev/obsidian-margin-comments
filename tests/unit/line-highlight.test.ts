import { describe, it, expect } from "vitest";
import { highlightRanges, markedRanges } from "../../src/editor/line-highlight";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = ["alpha line", "beta line", "gamma line"].join("\n");

/** A comment on a selection: the words themselves get marked. */
function commentOn(text: string, overrides: Partial<Comment> = {}): Comment {
	const from = doc.indexOf(text);
	return {
		id: `c-${text}`,
		filePath: "note.md",
		anchor: createAnchor(doc, from, from + text.length),
		content: "a comment",
		author: "someone",
		createdAt: 1,
		updatedAt: 1,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

/** A comment on a whole line: from === to is how that is asked for. */
function commentOnLine(text: string, overrides: Partial<Comment> = {}): Comment {
	const from = doc.indexOf(text);
	return {
		...commentOn(text, overrides),
		id: `line-${text}`,
		anchor: createAnchor(doc, from, from),
		...overrides,
	};
}

describe("highlightRanges, the line layer", () => {
	it("returns the line span for a whole-line comment", () => {
		const [range] = highlightRanges(doc, [commentOnLine("beta")]);
		expect(doc.slice(range.from, range.to)).toBe("beta line");
	});

	it("returns nothing for a comment made on a selection", () => {
		// The whole of #100: tinting the line claimed the comment was about all
		// of it, which is the claim reading mode already refuses to make.
		expect(highlightRanges(doc, [commentOn("beta")])).toEqual([]);
	});

	it("returns nothing for a resolved comment", () => {
		expect(highlightRanges(doc, [commentOnLine("beta", { resolved: true })])).toEqual([]);
	});

	it("returns nothing for an orphaned comment", () => {
		expect(highlightRanges("unrelated text", [commentOnLine("beta")])).toEqual([]);
	});

	it("ignores replies, which have no anchor of their own", () => {
		const root = commentOnLine("beta");
		const reply = commentOnLine("beta", { id: "r1", parentId: root.id });
		expect(highlightRanges(doc, [root, reply])).toHaveLength(1);
	});

	it("emits one span per line even when a line carries several line comments", () => {
		// Two tints on one line would double the background and read as a
		// different, darker state.
		const a = commentOnLine("beta");
		const b = commentOnLine("beta", { id: "line-second" });
		expect(highlightRanges(doc, [a, b])).toHaveLength(1);
	});

	it("follows the text when the note is reordered", () => {
		const comment = commentOnLine("beta");
		const reordered = ["gamma line", "alpha line", "beta line"].join("\n");
		const [range] = highlightRanges(reordered, [comment]);
		expect(reordered.slice(range.from, range.to)).toBe("beta line");
	});
});

describe("markedRanges, the selection layer", () => {
	it("marks the selected words and nothing else", () => {
		const [range] = markedRanges(doc, [commentOn("beta")]);
		expect(doc.slice(range.from, range.to)).toBe("beta");
	});

	it("returns nothing for a whole-line comment", () => {
		expect(markedRanges(doc, [commentOnLine("beta")])).toEqual([]);
	});

	it("shows both layers when a line carries both kinds", () => {
		// The clarification behind #100: the line tint underneath, the mark on
		// top, both visible.
		const both = [commentOnLine("beta"), commentOn("beta")];
		expect(highlightRanges(doc, both)).toHaveLength(1);
		expect(markedRanges(doc, both)).toHaveLength(1);
	});

	it("merges two marks over the same words into one", () => {
		// Two marks over the same characters nest, and two tints add up into a
		// band nobody defined.
		const a = commentOn("beta");
		const b = commentOn("beta", { id: "c-second" });
		expect(markedRanges(doc, [a, b])).toHaveLength(1);
	});

	it("merges overlapping marks into their union", () => {
		const wide = commentOn("beta line");
		const narrow = commentOn("beta");
		const [range] = markedRanges(doc, [wide, narrow]);
		expect(doc.slice(range.from, range.to)).toBe("beta line");
		expect(markedRanges(doc, [wide, narrow])).toHaveLength(1);
	});

	it("keeps marks on different words apart", () => {
		const ranges = markedRanges(doc, [commentOn("alpha"), commentOn("gamma")]);
		expect(ranges).toHaveLength(2);
		expect(ranges.map((r) => doc.slice(r.from, r.to))).toEqual(["alpha", "gamma"]);
	});

	it("returns ranges in document order, as CodeMirror requires", () => {
		const ranges = markedRanges(doc, [commentOn("gamma"), commentOn("alpha")]);
		expect(ranges.map((r) => r.from)).toEqual(
			[...ranges.map((r) => r.from)].sort((x, y) => x - y),
		);
	});
});
