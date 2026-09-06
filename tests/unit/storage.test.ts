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

			expect(summaries.map((s) => s.filePath).sort()).toEqual(["notes/meeting.md", "other.md"]);
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
