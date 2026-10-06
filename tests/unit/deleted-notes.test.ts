import { describe, it, expect } from "vitest";
import { describeNoteDeletion, describeNoteRestore } from "../../src/deleted-notes";

describe("the notices", () => {
	it("says how many comments went, and that they can come back", () => {
		const message = describeNoteDeletion("notes/deep/meeting.md", 3);
		expect(message).toContain("3 comments");
		expect(message).toContain("meeting");
		expect(message).toContain("come back if the note does");
	});

	it("no longer limits the promise to the session, because the hold is on disk now", () => {
		// #259: held in memory, this said "until Obsidian closes" — true then, and
		// the reason a note renamed outside Obsidian lost its comments.
		expect(describeNoteDeletion("notes/meeting.md", 1)).not.toContain("Obsidian closes");
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
