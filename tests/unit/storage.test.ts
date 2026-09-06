import { describe, it, expect, vi } from "vitest";
import { CommentStorage, STORAGE_DIR, INDEX_FILE } from "../../src/storage";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

function makeComment(overrides: Partial<Comment> = {}): Comment {
	return {
		id: "c1",
		filePath: "notes/meeting.md",
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
		content: "First comment",
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

const sidecarFor = (filePath: string) => `${STORAGE_DIR}/${hashString(filePath)}.json`;

describe("CommentStorage", () => {
	it("returns no comments for a note that has none", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		expect(await storage.getCommentsForFile("notes/meeting.md")).toEqual([]);
	});

	it("saves a comment and reads it back", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		const comment = makeComment();
		await storage.saveComment(comment);
		expect(await storage.getCommentsForFile("notes/meeting.md")).toEqual([comment]);
	});

	it("persists to a sidecar named from the note path hash", async () => {
		const adapter = new MemoryAdapter();
		await new CommentStorage(adapter).saveComment(makeComment());
		expect(Object.keys(adapter.snapshot())).toContain(sidecarFor("notes/meeting.md"));
	});

	it("stores the note path inside the sidecar so the store is self-describing", async () => {
		const adapter = new MemoryAdapter();
		await new CommentStorage(adapter).saveComment(makeComment());
		const written = JSON.parse(adapter.snapshot()[sidecarFor("notes/meeting.md")]);
		expect(written.filePath).toBe("notes/meeting.md");
	});

	it("creates the storage directory when it does not exist", async () => {
		const adapter = new MemoryAdapter();
		await new CommentStorage(adapter).saveComment(makeComment());
		expect(await adapter.exists(STORAGE_DIR)).toBe(true);
	});

	it("keeps comments for different notes in different sidecars", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		await storage.saveComment(makeComment({ id: "c2", filePath: "notes/other.md" }));
		expect(await storage.getCommentsForFile("notes/meeting.md")).toHaveLength(1);
		expect(await storage.getCommentsForFile("notes/other.md")).toHaveLength(1);
	});

	it("updates an existing comment in place", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment());
		await storage.updateComment({ ...makeComment(), content: "edited", updatedAt: 2000 });
		const [stored] = await storage.getCommentsForFile("notes/meeting.md");
		expect(stored.content).toBe("edited");
		expect(stored.createdAt).toBe(1000);
	});

	it("deletes one comment while leaving its siblings", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment());
		await storage.saveComment(makeComment({ id: "c2" }));
		await storage.deleteComment("notes/meeting.md", "c1");
		const remaining = await storage.getCommentsForFile("notes/meeting.md");
		expect(remaining.map((c) => c.id)).toEqual(["c2"]);
	});

	it("deletes a thread root together with its replies", async () => {
		// A reply whose root is gone can never be displayed or re-anchored, so
		// leaving it behind would strand it in the store forever.
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment());
		await storage.saveComment(makeComment({ id: "r1", parentId: "c1" }));
		await storage.saveComment(makeComment({ id: "c2" }));
		await storage.deleteComment("notes/meeting.md", "c1");
		const remaining = await storage.getCommentsForFile("notes/meeting.md");
		expect(remaining.map((c) => c.id)).toEqual(["c2"]);
	});

	it("deletes a reply without touching its root", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment());
		await storage.saveComment(makeComment({ id: "r1", parentId: "c1" }));
		await storage.deleteComment("notes/meeting.md", "r1");
		const remaining = await storage.getCommentsForFile("notes/meeting.md");
		expect(remaining.map((c) => c.id)).toEqual(["c1"]);
	});

	it("removes the sidecar when its last comment is deleted", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		await storage.deleteComment("notes/meeting.md", "c1");
		expect(await adapter.exists(sidecarFor("notes/meeting.md"))).toBe(false);
	});

	// A sidecar can be corrupted by a sync conflict. Losing one note's comments is
	// bad; taking the whole plugin down on load is worse.
	it("skips a corrupt sidecar instead of throwing", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const adapter = new MemoryAdapter({ [sidecarFor("notes/meeting.md")]: "{ not json" });
		const storage = new CommentStorage(adapter);
		await expect(storage.getCommentsForFile("notes/meeting.md")).resolves.toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("never writes to a Markdown file", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		await storage.updateComment({ ...makeComment(), content: "edited" });
		await storage.deleteComment("notes/meeting.md", "c1");
		expect(adapter.writes.filter((p) => p.endsWith(".md"))).toEqual([]);
	});

	describe("index", () => {
		it("records the note path and its thread counts", async () => {
			const adapter = new MemoryAdapter();
			await new CommentStorage(adapter).saveComment(makeComment());
			const index = JSON.parse(adapter.snapshot()[`${STORAGE_DIR}/${INDEX_FILE}`]);
			expect(index["notes/meeting.md"]).toEqual({
				hash: hashString("notes/meeting.md"),
				threads: 1,
				open: 1,
			});
		});

		it("counts threads, not comments", async () => {
			// The panel lists threads, so a reply must not inflate the count beside
			// a note that has one conversation on it.
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment());
			await storage.saveComment({ ...makeComment(), id: "c2", parentId: "c1" });

			const [summary] = await storage.getCommentSummaries();
			expect(summary).toEqual({ filePath: "notes/meeting.md", threads: 1, open: 1 });
		});

		it("follows a thread being resolved and reopened", async () => {
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment());

			await storage.updateComment({ ...makeComment(), resolved: true });
			expect((await storage.getCommentSummaries())[0]).toEqual({
				filePath: "notes/meeting.md",
				threads: 1,
				open: 0,
			});

			await storage.updateComment({ ...makeComment(), resolved: false });
			expect((await storage.getCommentSummaries())[0].open).toBe(1);
		});

		it("summarises the whole vault without opening a single sidecar", async () => {
			// The point of the counts living in the index: opening the all-files
			// view on a vault with hundreds of commented notes must not read them.
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment());
			await storage.saveComment({ ...makeComment(), id: "c9", filePath: "other.md" });

			const fresh = new CommentStorage(adapter);
			adapter.reads.length = 0;
			const summaries = await fresh.getCommentSummaries();

			expect(summaries.map((s) => s.filePath).sort()).toEqual([
				"notes/meeting.md",
				"other.md",
			]);
			expect(adapter.reads).toEqual([`${STORAGE_DIR}/${INDEX_FILE}`]);
		});

		it("drops an entry once the note turns out to have no sidecar", async () => {
			// A stale entry survives a half-finished sync. It is cleared the first
			// time anything asks for that note, rather than by an existence check
			// per entry on every summary.
			const adapter = new MemoryAdapter({
				[`${STORAGE_DIR}/${INDEX_FILE}`]: JSON.stringify({
					"gone.md": { hash: "deadbeefdeadbeef", threads: 2, open: 2 },
				}),
			});
			const storage = new CommentStorage(adapter);

			expect(await storage.getCommentsForFile("gone.md")).toEqual([]);
			expect(await storage.getCommentSummaries()).toEqual([]);
		});

		it("rebuilds an index written by an older version", async () => {
			// 0.1 stored a bare hash per note. Counting it as zero threads would
			// show every existing vault an empty all-files view.
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment());
			await adapter.write(
				`${STORAGE_DIR}/${INDEX_FILE}`,
				JSON.stringify({ "notes/meeting.md": hashString("notes/meeting.md") }),
			);

			const fresh = new CommentStorage(adapter);
			expect(await fresh.getCommentSummaries()).toEqual([
				{ filePath: "notes/meeting.md", threads: 1, open: 1 },
			]);
		});

		it("rebuilds itself by scanning when the index is missing", async () => {
			const adapter = new MemoryAdapter();
			await new CommentStorage(adapter).saveComment(makeComment());
			await adapter.remove(`${STORAGE_DIR}/${INDEX_FILE}`);
			const fresh = new CommentStorage(adapter);
			expect((await fresh.getCommentSummaries()).map((s) => s.filePath)).toEqual([
				"notes/meeting.md",
			]);
		});

		it("forgets a note whose last comment was deleted", async () => {
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment());
			await storage.deleteComment("notes/meeting.md", "c1");
			expect(await storage.getCommentSummaries()).toEqual([]);
		});
	});
});

describe("moveComments", () => {
	it("finds the comments again under the new path", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment());
		await storage.moveComments("notes/meeting.md", "notes/standup.md");

		expect(await storage.getCommentsForFile("notes/standup.md")).toHaveLength(1);
	});

	it("leaves nothing behind at the old path", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		await storage.moveComments("notes/meeting.md", "notes/standup.md");

		expect(await storage.getCommentsForFile("notes/meeting.md")).toEqual([]);
		expect(Object.keys(adapter.snapshot())).not.toContain(sidecarFor("notes/meeting.md"));
	});

	it("rewrites filePath on every comment, so a rebuild does not undo the move", async () => {
		// The index is a derived cache; when it is gone the sidecar's own
		// filePath is what says where the comments belong.
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "root" }));
		await storage.saveComment(makeComment({ id: "reply", parentId: "root" }));
		await storage.moveComments("notes/meeting.md", "notes/standup.md");

		const moved = await storage.getCommentsForFile("notes/standup.md");
		expect(moved.map((c) => c.filePath)).toEqual(["notes/standup.md", "notes/standup.md"]);
	});

	it("moves the index entry, so the all-notes view lists the new path", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		await storage.moveComments("notes/meeting.md", "notes/standup.md");

		expect((await storage.getCommentSummaries()).map((s) => s.filePath)).toEqual([
			"notes/standup.md",
		]);
	});

	it("keeps the counts the index promised", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "open" }));
		await storage.saveComment(makeComment({ id: "done", resolved: true }));
		await storage.moveComments("notes/meeting.md", "notes/standup.md");

		expect(await storage.getCommentSummaries()).toEqual([
			{ filePath: "notes/standup.md", threads: 2, open: 1 },
		]);
	});

	it("does nothing for a note that has no comments", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.moveComments("notes/empty.md", "notes/still-empty.md");

		expect(adapter.writes).toEqual([]);
	});

	it("keeps comments already at the target rather than overwriting them", async () => {
		// Obsidian will not rename onto an existing note, so a sidecar at the
		// target belongs to a note that is already gone. Its comments are
		// orphaned, which is not the same as disposable.
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "moving" }));
		await storage.saveComment(makeComment({ id: "stranded", filePath: "notes/standup.md" }));
		await storage.moveComments("notes/meeting.md", "notes/standup.md");

		const landed = await storage.getCommentsForFile("notes/standup.md");
		expect(landed.map((c) => c.id).sort()).toEqual(["moving", "stranded"]);
	});

	it("does not duplicate when a second move starts mid-way through the first", async () => {
		// Obsidian emits a folder rename for the folder and again for every
		// descendant, so the same note really does arrive twice. The window is
		// between the target being written and the source being removed: the
		// second mover reads the comments off the still-present source and
		// appends them to the target it just found them in. Without the guard
		// this lands two copies of the thread.
		class SlowRemove extends MemoryAdapter {
			gate: (() => void) | null = null;
			async remove(path: string): Promise<void> {
				if (this.gate) {
					const open = this.gate;
					this.gate = null;
					open();
					await new Promise((r) => setTimeout(r, 20));
				}
				return super.remove(path);
			}
		}
		const adapter = new SlowRemove();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());

		const reached = new Promise<void>((resolve) => {
			adapter.gate = resolve;
		});
		const first = storage.moveComments("notes/meeting.md", "notes/standup.md");
		await reached;
		await storage.moveComments("notes/meeting.md", "notes/standup.md");
		await first;

		expect(await storage.getCommentsForFile("notes/standup.md")).toHaveLength(1);
	});

	it("refuses to move a note onto itself", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		const writesBefore = adapter.writes.length;

		await storage.moveComments("notes/meeting.md", "notes/meeting.md");

		expect(await storage.getCommentsForFile("notes/meeting.md")).toHaveLength(1);
		expect(adapter.writes.length).toBe(writesBefore);
	});
});

describe("takeComments and restoreComments", () => {
	it("hands back the comments it removed", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "a" }));
		await storage.saveComment(makeComment({ id: "b" }));

		const taken = await storage.takeComments("notes/meeting.md");
		expect(taken.map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("leaves the store empty afterwards, index included", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment());
		await storage.takeComments("notes/meeting.md");

		expect(await storage.getCommentsForFile("notes/meeting.md")).toEqual([]);
		expect(await storage.getCommentSummaries()).toEqual([]);
		expect(Object.keys(adapter.snapshot())).not.toContain(sidecarFor("notes/meeting.md"));
	});

	it("takes nothing, and writes nothing, for a note with no comments", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		expect(await storage.takeComments("notes/empty.md")).toEqual([]);
		expect(adapter.writes).toEqual([]);
	});

	it("puts them back where they were", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "a" }));
		const taken = await storage.takeComments("notes/meeting.md");
		await storage.restoreComments("notes/meeting.md", taken);

		expect((await storage.getCommentsForFile("notes/meeting.md")).map((c) => c.id)).toEqual([
			"a",
		]);
		expect(await storage.getCommentSummaries()).toEqual([
			{ filePath: "notes/meeting.md", threads: 1, open: 1 },
		]);
	});

	it("keeps a comment written while the note was away", async () => {
		// The note can be deleted, recreated and commented on before the restore
		// lands; replacing rather than merging throws that comment away.
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "old" }));
		const taken = await storage.takeComments("notes/meeting.md");
		await storage.saveComment(makeComment({ id: "new" }));
		await storage.restoreComments("notes/meeting.md", taken);

		const landed = await storage.getCommentsForFile("notes/meeting.md");
		expect(landed.map((c) => c.id).sort()).toEqual(["new", "old"]);
	});

	it("does not double a comment restored twice", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment({ id: "a" }));
		const taken = await storage.takeComments("notes/meeting.md");
		await storage.restoreComments("notes/meeting.md", taken);
		await storage.restoreComments("notes/meeting.md", taken);

		expect(await storage.getCommentsForFile("notes/meeting.md")).toHaveLength(1);
	});
});
