import { describe, it, expect } from "vitest";
import { withEditedContent, withResolved } from "../../src/ui/comment-actions";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const base: Comment = {
	id: "a",
	filePath: "note.md",
	anchor: createAnchor("alpha line", 0, 5),
	content: "original",
	author: "someone",
	createdAt: 1000,
	updatedAt: 1000,
	resolved: false,
	parentId: null,
};

describe("withEditedContent", () => {
	it("replaces the body", () => {
		expect(withEditedContent(base, "edited", 2000).content).toBe("edited");
	});

	it("bumps updatedAt", () => {
		expect(withEditedContent(base, "edited", 2000).updatedAt).toBe(2000);
	});

	it("never touches createdAt", () => {
		// The card shows an "edited" marker by comparing the two; moving createdAt
		// would erase the evidence that an edit happened.
		expect(withEditedContent(base, "edited", 2000).createdAt).toBe(1000);
	});

	it("leaves the anchor alone", () => {
		// Editing the comment says nothing about the text it points at.
		expect(withEditedContent(base, "edited", 2000).anchor).toEqual(base.anchor);
	});

	it("does not mutate the original", () => {
		withEditedContent(base, "edited", 2000);
		expect(base.content).toBe("original");
	});
});

describe("withResolved", () => {
	it("marks a comment resolved", () => {
		expect(withResolved(base, true, 2000).resolved).toBe(true);
	});

	it("reopens a resolved comment", () => {
		expect(withResolved({ ...base, resolved: true }, false, 2000).resolved).toBe(false);
	});

	it("bumps updatedAt so last-activity sorting sees it", () => {
		expect(withResolved(base, true, 2000).updatedAt).toBe(2000);
	});

	it("leaves the body untouched", () => {
		expect(withResolved(base, true, 2000).content).toBe("original");
	});

	it("does not mutate the original", () => {
		withResolved(base, true, 2000);
		expect(base.resolved).toBe(false);
	});
});
