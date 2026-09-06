import { describe, it, expect } from "vitest";
import {
	describeDeletion,
	describeResolveAll,
	openRoots,
	wasEdited,
	withEditedContent,
	withResolved,
} from "../../src/ui/comment-actions";
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

describe("wasEdited", () => {
	it("is false for an untouched comment", () => {
		expect(wasEdited(base)).toBe(false);
	});

	it("is true once the body has been edited", () => {
		expect(wasEdited(withEditedContent(base, "edited", 2000))).toBe(true);
	});

	it("stays false after resolving", () => {
		// Resolving moves updatedAt so last-activity sorting notices it. Deriving
		// "edited" from that same field labels every resolved comment as edited.
		expect(wasEdited(withResolved(base, true, 2000))).toBe(false);
	});

	it("stays true after a resolve that follows an edit", () => {
		const edited = withEditedContent(base, "edited", 2000);
		expect(wasEdited(withResolved(edited, true, 3000))).toBe(true);
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

describe("describeDeletion", () => {
	const root = { ...base, id: "root" };
	const reply = { ...base, id: "r1", parentId: "root" };

	it("names a lone comment plainly", () => {
		expect(describeDeletion(root, [root])).toBe("Delete this comment?");
	});

	it("warns how many replies go with a thread root", () => {
		// The count is the whole point: deleting a root silently taking three
		// replies with it is the surprise this dialog exists to prevent.
		expect(describeDeletion(root, [root, reply, { ...reply, id: "r2" }])).toBe(
			"Delete this comment and its 2 replies?",
		);
	});

	it("uses the singular for one reply", () => {
		expect(describeDeletion(root, [root, reply])).toBe("Delete this comment and its 1 reply?");
	});

	it("does not count another thread's replies", () => {
		const other = { ...base, id: "other" };
		const otherReply = { ...base, id: "r9", parentId: "other" };
		expect(describeDeletion(root, [root, other, otherReply])).toBe("Delete this comment?");
	});

	it("treats deleting a reply as deleting one comment", () => {
		expect(describeDeletion(reply, [root, reply])).toBe("Delete this reply?");
	});
});

describe("openRoots", () => {
	const root = (id: string, resolved: boolean): Comment => ({ ...base, id, resolved });
	const reply = (id: string, parentId: string): Comment => ({ ...base, id, parentId });

	it("keeps only unresolved roots", () => {
		const comments = [root("a", false), root("b", true), root("c", false)];
		expect(openRoots(comments).map((c) => c.id)).toEqual(["a", "c"]);
	});

	it("ignores replies, which carry no resolved state of their own", () => {
		// A reply has resolved: false by default. Counting them would offer to
		// resolve threads that are already resolved.
		const comments = [root("a", true), reply("r", "a")];
		expect(openRoots(comments)).toEqual([]);
	});
});

describe("describeResolveAll", () => {
	it("names how many threads the action covers", () => {
		expect(describeResolveAll(3)).toBe("Resolve 3 open threads in this note?");
	});

	it("stays grammatical for one", () => {
		expect(describeResolveAll(1)).toBe("Resolve 1 open thread in this note?");
	});
});
