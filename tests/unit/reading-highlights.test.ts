import { describe, it, expect } from "vitest";
import { highlightsInBlock, locateAcrossSegments } from "../../src/reading/reading-highlights";
import type { Thread } from "../../src/threads";
import type { Comment } from "../../src/types";

function comment(id: string, overrides: Partial<Comment> = {}): Comment {
	return {
		id,
		filePath: "note.md",
		anchor: {
			selectedText: "text",
			textHash: "h",
			isLineComment: false,
			contextBefore: "",
			contextAfter: "",
			lineHint: 1,
			startOffset: 0,
			endOffset: 4,
		},
		content: "a comment",
		author: "",
		createdAt: 1,
		updatedAt: 1,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

function thread(
	id: string,
	line: number | null,
	position: number,
	end: number,
	over: Partial<Thread> = {},
): Thread {
	return {
		root: comment(id),
		replies: [],
		line,
		position,
		end,
		orphaned: line === null,
		...over,
	};
}

describe("highlightsInBlock", () => {
	const doc = "first line\nsecond line\nthird line";

	it("takes the threads whose line falls inside the block", () => {
		// getSectionInfo counts lines from zero; Thread.line counts from one.
		const threads = [
			thread("a", 1, 0, 5),
			thread("b", 2, doc.indexOf("second"), doc.indexOf("second") + 6),
			thread("c", 3, doc.indexOf("third"), doc.indexOf("third") + 5),
		];
		expect(highlightsInBlock(doc, threads, 1, 1).map((h) => h.id)).toEqual(["b"]);
		expect(highlightsInBlock(doc, threads, 0, 2).map((h) => h.id)).toEqual(["a", "b", "c"]);
	});

	it("reads the text back from the document, not from the stored anchor", () => {
		// The anchor's selectedText is what was commented on; the fuzzy stage may
		// have found the comment somewhere the text now reads differently, and
		// reading mode renders the document as it stands.
		const at = doc.indexOf("second line");
		const moved = thread("b", 2, at, at + 11);
		moved.root.anchor.selectedText = "the words as they used to be";
		expect(highlightsInBlock(doc, [moved], 1, 1)[0].text).toBe("second line");
	});

	it("leaves out resolved and orphaned threads", () => {
		const resolved = thread("done", 1, 0, 5);
		resolved.root.resolved = true;
		const orphan = thread("gone", null, 0, 5);
		expect(highlightsInBlock(doc, [resolved, orphan], 0, 2)).toEqual([]);
	});

	it("gives a whole-line comment no text to look for", () => {
		// There is no selection to find in the rendered output, so the caller
		// marks the block rather than guessing at a range.
		const line = thread("line", 1, 0, 10);
		line.root.anchor.isLineComment = true;
		expect(highlightsInBlock(doc, [line], 0, 0)).toEqual([
			{ id: "line", text: "", occurrence: 0 },
		]);
	});

	it("orders by position, so nested marks are applied outermost first", () => {
		const later = thread("later", 1, 6, 10);
		const earlier = thread("earlier", 1, 0, 5);
		expect(highlightsInBlock(doc, [later, earlier], 0, 0).map((h) => h.id)).toEqual([
			"earlier",
			"later",
		]);
	});

	it("counts earlier appearances of the same words inside the block (#175)", () => {
		const list = "Numbered zero\n\n1. Numbered one\n2. Numbered two";
		const first = list.indexOf("Numbered one");
		const second = list.indexOf("Numbered two");
		const threads = [thread("two", 4, second, second + 8), thread("one", 3, first, first + 8)];
		// The block is lines 2 and 3, so the appearance above it does not count.
		expect(highlightsInBlock(list, threads, 2, 3).map((h) => [h.id, h.occurrence])).toEqual([
			["one", 0],
			["two", 1],
		]);
	});

	it("counts whitespace the way the search does", () => {
		// A soft-wrapped repeat still counts: the renderer turns the newline into a space.
		const text = "red\nfox and red fox";
		const at = text.lastIndexOf("red fox");
		expect(highlightsInBlock(text, [thread("b", 2, at, at + 7)], 0, 1)[0].occurrence).toBe(1);
	});
});

describe("locateAcrossSegments", () => {
	it("finds a needle inside one segment", () => {
		expect(locateAcrossSegments(["the commented words here"], "commented words")).toEqual([
			{ index: 0, start: 4, end: 19 },
		]);
	});

	it("spans segments, which is what an inline link or bold splits text into", () => {
		// "a **bold** word" renders as three text nodes; a comment on the whole
		// phrase has to reach across all of them.
		expect(locateAcrossSegments(["a ", "bold", " word"], "a bold word")).toEqual([
			{ index: 0, start: 0, end: 2 },
			{ index: 1, start: 0, end: 4 },
			{ index: 2, start: 0, end: 5 },
		]);
	});

	it("matches across a newline the renderer turned into a space", () => {
		// A selection over a soft-wrapped sentence carries the newline; the
		// rendered text has a single space there.
		expect(locateAcrossSegments(["one two three"], "one\ntwo")).toEqual([
			{ index: 0, start: 0, end: 7 },
		]);
	});

	it("matches when the source indented what the renderer did not", () => {
		expect(locateAcrossSegments(["buy milk today"], "buy    milk")).toEqual([
			{ index: 0, start: 0, end: 8 },
		]);
	});

	it("gives up rather than guess when the markup was consumed", () => {
		// "**bold**" renders as "bold": the asterisks are simply not there, and a
		// partial match would mark the wrong words.
		expect(locateAcrossSegments(["a bold word"], "**bold**")).toBeNull();
	});

	it("gives up on an empty needle, which a whole-line comment has", () => {
		expect(locateAcrossSegments(["some text"], "")).toBeNull();
		expect(locateAcrossSegments(["some text"], "   \n ")).toBeNull();
	});

	it("returns no empty slice for a needle that ends on a segment boundary", () => {
		// An empty slice would wrap nothing and leave a stray span behind.
		const slices = locateAcrossSegments(["first", "second"], "first")!;
		expect(slices).toEqual([{ index: 0, start: 0, end: 5 }]);
	});

	it("finds a later appearance when asked for it (#175)", () => {
		expect(locateAcrossSegments(["Numbered one", "Numbered two"], "Numbered", 1)).toEqual([
			{ index: 1, start: 0, end: 8 },
		]);
	});

	it("gives up when the block has fewer appearances than asked for", () => {
		// The renderer consumed one: marking another appearance would be a guess.
		expect(locateAcrossSegments(["Numbered one"], "Numbered", 1)).toBeNull();
	});
});
