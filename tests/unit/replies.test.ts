import { describe, it, expect } from "vitest";
import { createReply, rootIdFor } from "../../src/ui/replies";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = "alpha line\nbeta line";

function make(id: string, overrides: Partial<Comment> = {}): Comment {
	return {
		id,
		filePath: "note.md",
		anchor: createAnchor(doc, 0, 5),
		content: `body of ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

describe("rootIdFor", () => {
	it("returns a root's own id", () => {
		expect(rootIdFor(make("a"))).toBe("a");
	});

	it("returns the root id when given a reply", () => {
		// Replying to a reply must still hang off the root: the model is flat, and
		// a parentId pointing at a reply would create a second level nothing renders.
		expect(rootIdFor(make("r1", { parentId: "a" }))).toBe("a");
	});
});

describe("createReply", () => {
	const root = make("a");

	it("points at the root", () => {
		expect(createReply(root, "my reply", "me").parentId).toBe("a");
	});

	it("points at the root even when replying to a reply", () => {
		const reply = make("r1", { parentId: "a" });
		expect(createReply(reply, "second reply", "me").parentId).toBe("a");
	});

	it("inherits the root's anchor rather than anchoring itself", () => {
		// A reply has no text of its own to anchor to; re-anchoring would let it
		// drift away from the comment it answers.
		expect(createReply(root, "my reply", "me").anchor).toEqual(root.anchor);
	});

	it("inherits the note path", () => {
		expect(createReply(root, "my reply", "me").filePath).toBe("note.md");
	});

	it("carries the given content and author", () => {
		const reply = createReply(root, "my reply", "me");
		expect(reply.content).toBe("my reply");
		expect(reply.author).toBe("me");
	});

	it("starts unresolved", () => {
		// resolved is only meaningful on a root; a reply carries the default.
		expect(createReply(make("a", { resolved: true }), "r", "me").resolved).toBe(false);
	});

	it("gets its own id, distinct from the root", () => {
		const reply = createReply(root, "my reply", "me");
		expect(reply.id).not.toBe(root.id);
		expect(reply.id).toBeTruthy();
	});

	it("timestamps creation and update together", () => {
		const reply = createReply(root, "my reply", "me", 5000);
		expect(reply.createdAt).toBe(5000);
		expect(reply.updatedAt).toBe(5000);
	});
});
