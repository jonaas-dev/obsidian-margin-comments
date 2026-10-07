import { describe, it, expect } from "vitest";
import { createAnchor, matchAnchor } from "../../src/anchor";

/**
 * #261: a whole-line comment on an empty line stores `selectedText: ""`. Stage 1
 * never matches an empty text and stage 3 refuses one, so stage 2 was the only
 * way back — and it needs eight characters of context on *both* sides. Several
 * ordinary empty lines were orphaned the moment the comment was made.
 *
 * Every case here is a row of the table measured on the issue.
 */

/** Comment the whole of the line that starts at `offset`, as a gutter press does. */
const anchorAt = (doc: string, offset: number) => createAnchor(doc, offset, offset);

/** Where the line that starts at `offset` is, after the note changed to `doc`. */
const relocate = (doc: string, anchor: ReturnType<typeof createAnchor>) =>
	matchAnchor(doc, anchor, { fuzzy: true, threshold: 0.3 });

describe("a comment on an empty line", () => {
	it("survives being made between two short paragraphs", () => {
		const doc = "Hi\n\nBye";
		const anchor = anchorAt(doc, 3);
		expect(anchor.selectedText).toBe("");
		// Three characters of context before it, which is all the note has.
		expect(relocate(doc, anchor)).toEqual({ from: 3, to: 3, method: expect.any(String) });
	});

	it("survives being made above a list", () => {
		const doc = "Title\n\n- item one\n- item two\n\nEnd";
		const anchor = anchorAt(doc, 6);
		expect(relocate(doc, anchor)).toEqual({ from: 6, to: 6, method: expect.any(String) });
	});

	it("survives being made on the last line, where there is nothing after it", () => {
		const doc = "Some paragraph text long enough.\n\n";
		const anchor = anchorAt(doc, doc.length);
		expect(anchor.contextAfter).toBe("");
		expect(relocate(doc, anchor)).toEqual({
			from: doc.length,
			to: doc.length,
			method: expect.any(String),
		});
	});

	it("survives being made on the first line, where there is nothing before it", () => {
		const doc = "\nFirst paragraph with enough words to matter.\nAnd a second one here.";
		const anchor = anchorAt(doc, 0);
		expect(relocate(doc, anchor)).toEqual({ from: 0, to: 0, method: expect.any(String) });
	});

	it("survives an edit at the end of the paragraph above it", () => {
		// The most ordinary edit there is next to an empty line, and the one that
		// orphaned the comment even when it had been anchored to begin with.
		const doc = "A long enough first paragraph here.\n\nAnother long enough paragraph here.";
		const anchor = anchorAt(doc, 36);
		const edited =
			"A long enough first paragraph here, edited.\n\nAnother long enough paragraph here.";
		expect(relocate(edited, anchor)).toEqual({ from: 44, to: 44, method: expect.any(String) });
	});

	it("follows the line down when something is inserted above it", () => {
		const doc = "A long enough first paragraph here.\n\nAnother long enough paragraph here.";
		const anchor = anchorAt(doc, 36);
		const inserted = `A new first line.\n${doc}`;
		expect(relocate(inserted, anchor)).toEqual({
			from: 54,
			to: 54,
			method: expect.any(String),
		});
	});

	it("is reported lost when the neighbourhood is gone", () => {
		// Not anchoring at all is better than anchoring somewhere arbitrary: the
		// reader is told, and the comment is recoverable.
		const doc = "A long enough first paragraph here.\n\nAnother long enough paragraph here.";
		const anchor = anchorAt(doc, 36);
		expect(relocate("Nothing of the original note survives this rewrite.", anchor)).toBeNull();
	});
});

describe("the first line of a note that starts with a blank line", () => {
	it("is line 1, with no context before it", () => {
		// lineRangeAt(doc, 0) found the newline at offset 0 and reported the line
		// after it, so the anchor recorded context that does not exist.
		const doc = "\nFirst paragraph with enough words to matter.";
		const anchor = createAnchor(doc, 0, 0);
		expect(anchor.lineHint).toBe(1);
		expect(anchor.contextBefore).toBe("");
	});
});
