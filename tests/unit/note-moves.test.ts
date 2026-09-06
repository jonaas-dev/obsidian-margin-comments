import { describe, it, expect } from "vitest";
import { movedPath, movesFor } from "../../src/note-moves";

describe("movedPath", () => {
	it("takes the new path when the note itself was renamed", () => {
		expect(movedPath("notes/meeting.md", "notes/meeting.md", "notes/standup.md")).toBe(
			"notes/standup.md",
		);
	});

	it("follows a note into its folder's new name", () => {
		expect(movedPath("notes/deep/meeting.md", "notes", "archive")).toBe(
			"archive/deep/meeting.md",
		);
	});

	it("follows a note when the folder moves rather than is renamed", () => {
		expect(movedPath("notes/meeting.md", "notes", "2026/notes")).toBe("2026/notes/meeting.md");
	});

	it("leaves an unrelated note alone", () => {
		expect(movedPath("other/meeting.md", "notes", "archive")).toBeNull();
	});

	it("does not claim a sibling whose name merely starts the same", () => {
		// Prefix matching without the separator moves notes-archive/ along with
		// notes/, which is how a rename quietly reaches files nobody touched.
		expect(movedPath("notes-archive/meeting.md", "notes", "archive")).toBeNull();
	});

	it("does not treat a note as the folder it sits beside", () => {
		expect(movedPath("notes.md", "notes", "archive")).toBeNull();
	});
});

describe("movesFor", () => {
	it("lists every commented note under a renamed folder", () => {
		const paths = ["notes/a.md", "notes/deep/b.md", "other/c.md"];
		expect(movesFor(paths, "notes", "archive")).toEqual([
			{ from: "notes/a.md", to: "archive/a.md" },
			{ from: "notes/deep/b.md", to: "archive/deep/b.md" },
		]);
	});

	it("is empty when the rename touches nothing with comments", () => {
		expect(movesFor(["notes/a.md"], "other", "elsewhere")).toEqual([]);
	});

	it("skips a rename onto the same path", () => {
		// A move onto itself writes the sidecar and then deletes the one it just
		// wrote, so the comments would be gone.
		expect(movesFor(["notes/a.md"], "notes/a.md", "notes/a.md")).toEqual([]);
	});
});
