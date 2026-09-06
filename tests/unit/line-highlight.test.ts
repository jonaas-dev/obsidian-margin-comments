import { describe, it, expect } from "vitest";
import { highlightRanges } from "../../src/editor/line-highlight";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = ["alpha line", "beta line", "gamma line"].join("\n");

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

describe("highlightRanges", () => {
	it("returns the line span for an anchored comment", () => {
		const [range] = highlightRanges(doc, [commentOn("beta")]);
		expect(doc.slice(range.from, range.to)).toBe("beta line");
	});

	it("returns nothing for a resolved comment", () => {
		expect(highlightRanges(doc, [commentOn("beta", { resolved: true })])).toEqual([]);
	});

	it("returns nothing for an orphaned comment", () => {
		expect(highlightRanges("unrelated text", [commentOn("beta")])).toEqual([]);
	});

	it("ignores replies, which have no anchor of their own", () => {
		const root = commentOn("beta");
		const reply = commentOn("beta", { id: "r1", parentId: root.id });
		expect(highlightRanges(doc, [root, reply])).toHaveLength(1);
	});

	it("emits one range per line even when a line carries several comments", () => {
		// Two decorations on the same line would double the background tint and
		// read as a different, darker state.
		const a = commentOn("beta");
		const b = { ...commentOn("beta"), id: "c-second" };
		expect(highlightRanges(doc, [a, b])).toHaveLength(1);
	});

	it("returns ranges sorted by position, as CodeMirror requires", () => {
		const ranges = highlightRanges(doc, [commentOn("gamma"), commentOn("alpha")]);
		expect(ranges.map((r) => r.from)).toEqual([...ranges.map((r) => r.from)].sort((x, y) => x - y));
	});

	it("follows the text when the note is reordered", () => {
		const comment = commentOn("beta");
		const reordered = ["gamma line", "alpha line", "beta line"].join("\n");
		const [range] = highlightRanges(reordered, [comment]);
		expect(reordered.slice(range.from, range.to)).toBe("beta line");
	});
});
