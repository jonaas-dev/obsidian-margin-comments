import { describe, it, expect } from "vitest";
import { DeletedNotes, describeNoteDeletion, describeNoteRestore } from "../../src/deleted-notes";
import type { Comment } from "../../src/types";

function comment(id: string): Comment {
	return {
		id,
		filePath: "notes/meeting.md",
		anchor: {
			selectedText: "hello",
			textHash: "h",
			isLineComment: false,
			contextBefore: "",
			contextAfter: "",
			lineHint: 1,
			startOffset: 0,
			endOffset: 5,
		},
		content: `body of ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

describe("DeletedNotes", () => {
	it("gives back what it was holding for a path", () => {
		const bin = new DeletedNotes();
		bin.remember("notes/meeting.md", [comment("a"), comment("b")]);
		expect(bin.recover("notes/meeting.md")?.map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("knows nothing about a note it never held", () => {
		expect(new DeletedNotes().recover("notes/other.md")).toBeNull();
	});

	it("stops holding a note once it has been recovered", () => {
		// Otherwise a second create on the same path — a new note the user wrote
		// from scratch — arrives carrying a dead note's comments.
		const bin = new DeletedNotes();
		bin.remember("notes/meeting.md", [comment("a")]);
		bin.recover("notes/meeting.md");
		expect(bin.recover("notes/meeting.md")).toBeNull();
		expect(bin.size).toBe(0);
	});

	it("holds nothing for a note that had no comments", () => {
		const bin = new DeletedNotes();
		bin.remember("notes/meeting.md", []);
		expect(bin.size).toBe(0);
		expect(bin.recover("notes/meeting.md")).toBeNull();
	});

	it("keeps notes apart", () => {
		const bin = new DeletedNotes();
		bin.remember("a.md", [comment("one")]);
		bin.remember("b.md", [comment("two")]);
		expect(bin.recover("a.md")?.map((c) => c.id)).toEqual(["one"]);
		expect(bin.recover("b.md")?.map((c) => c.id)).toEqual(["two"]);
	});

	it("merges a second delete of the same path without duplicating", () => {
		// Deleting a note twice in a session means it came back in between, so
		// the second set is the current one and the first may hold comments the
		// restore had not put back yet.
		const bin = new DeletedNotes();
		bin.remember("notes/meeting.md", [comment("a")]);
		bin.remember("notes/meeting.md", [comment("a"), comment("b")]);
		expect(bin.recover("notes/meeting.md")?.map((c) => c.id)).toEqual(["a", "b"]);
	});
});

describe("the notices", () => {
	it("says how many comments went, and that they can come back", () => {
		const message = describeNoteDeletion("notes/deep/meeting.md", 3);
		expect(message).toContain("3 comments");
		expect(message).toContain("meeting");
		expect(message).toContain("Restoring the note");
	});

	it("does not promise the recovery outlives the session, because it does not", () => {
		expect(describeNoteDeletion("notes/meeting.md", 1)).toContain("until Obsidian closes");
	});

	it("uses the singular for one", () => {
		expect(describeNoteDeletion("notes/meeting.md", 1)).toContain("1 comment removed");
		expect(describeNoteRestore("notes/meeting.md", 1)).toContain("1 comment restored");
	});

	it("names the note without its folder or extension", () => {
		expect(describeNoteRestore("notes/deep/meeting.md", 2)).toBe(
			"2 comments restored with meeting.",
		);
	});
});
