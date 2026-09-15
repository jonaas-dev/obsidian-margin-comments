import { describe, it, expect } from "vitest";
import { CommentNotFoundError, CommentStorage } from "../../src/storage";
import { withEditedContent, withResolved } from "../../src/ui/comment-actions";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

/**
 * A change names the comment and says what to do to it. It is applied to the stored
 * copy inside the note's queue, never to a copy the UI drew earlier (#264).
 */

const NOTE = "notes/meeting.md";

function root(overrides: Partial<Comment> = {}): Comment {
	return {
		id: "root",
		filePath: NOTE,
		anchor: {
			selectedText: "hello",
			textHash: hashString("hello"),
			isLineComment: false,
			contextBefore: "",
			contextAfter: "",
			lineHint: 1,
			startOffset: 0,
			endOffset: 5,
		},
		content: "original",
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

describe("updateComment", () => {
	it("keeps an edit when the comment is resolved from a copy drawn before it", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		const drawn = root();
		await storage.saveComment(drawn);

		await storage.updateComment(NOTE, drawn.id, (stored) =>
			withEditedContent(stored, "edited", 2000),
		);
		await storage.updateComment(NOTE, drawn.id, (stored) => withResolved(stored, true, 3000));

		const [saved] = await storage.getCommentsForFile(NOTE);
		expect(saved).toMatchObject({
			content: "edited",
			resolved: true,
			updatedAt: 3000,
			editedAt: 2000,
		});
	});

	it("keeps a resolve when the comment is then edited from a copy drawn before it", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(root());

		await Promise.all([
			storage.updateComment(NOTE, "root", (stored) => withResolved(stored, true, 2000)),
			storage.updateComment(NOTE, "root", (stored) =>
				withEditedContent(stored, "edited", 3000),
			),
		]);

		expect(await storage.getCommentsForFile(NOTE)).toMatchObject([
			{ content: "edited", resolved: true },
		]);
	});

	it("reports a change to a comment that no longer exists", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(root());
		await storage.deleteComment(NOTE, "root");
		const writes = adapter.writes.length;

		await expect(
			storage.updateComment(NOTE, "root", (stored) => withEditedContent(stored, "too late")),
		).rejects.toBeInstanceOf(CommentNotFoundError);
		expect(adapter.writes.length).toBe(writes);
	});

	it("keeps the comment's identity whatever the change returns", async () => {
		// The id and note are what the change is addressed to; a change that rewrote
		// them would move or duplicate a comment through what reads as an edit.
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(root());

		await storage.updateComment(NOTE, "root", (stored) => ({
			...stored,
			id: "other",
			filePath: "elsewhere.md",
			content: "edited",
		}));

		expect(await storage.getCommentsForFile(NOTE)).toMatchObject([
			{ id: "root", content: "edited" },
		]);
		expect(await storage.getCommentsForFile("elsewhere.md")).toEqual([]);
	});
});
