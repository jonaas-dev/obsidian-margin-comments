import { describe, it, expect, vi } from "vitest";
import {
	CommentStorage,
	STORAGE_DIR,
	INDEX_FILE,
	describeInvalidComments,
	describeUnreadableSidecar,
} from "../../src/storage";
import { buildThreads } from "../../src/ui/threads";
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

	describe("an unreadable sidecar", () => {
		const NOTE = "notes/meeting.md";
		// What a crash mid-write or a half-finished sync leaves: a real sidecar, cut short.
		const truncated = JSON.stringify(
			{ filePath: NOTE, comments: [makeComment({ id: "old1" }), makeComment({ id: "old2" })] },
			null,
			2,
		).slice(0, 400);
		const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});
		const keptCopies = (adapter: MemoryAdapter, content: string) =>
			Object.entries(adapter.snapshot())
				.filter(([path, data]) => data === content && path !== sidecarFor(NOTE))
				.map(([path]) => path);

		it("keeps its bytes when the next comment is saved", async () => {
			const warn = quiet();
			const adapter = new MemoryAdapter({ [sidecarFor(NOTE)]: truncated });
			const storage = new CommentStorage(adapter);

			expect(await storage.getCommentsForFile(NOTE)).toEqual([]);
			await storage.saveComment(makeComment({ id: "new" }));

			expect(keptCopies(adapter, truncated)).toHaveLength(1);
			const [kept] = keptCopies(adapter, truncated);
			expect(kept.startsWith(`${STORAGE_DIR}/`)).toBe(true);
			const written = JSON.parse(adapter.snapshot()[sidecarFor(NOTE)]);
			expect(written.comments.map((c: Comment) => c.id)).toEqual(["new"]);
			warn.mockRestore();
		});

		it("keeps one whose JSON parses but holds no comments array", async () => {
			const warn = quiet();
			const wrongShape = JSON.stringify({ filePath: NOTE, comments: "nope" });
			const adapter = new MemoryAdapter({ [sidecarFor(NOTE)]: wrongShape });
			const storage = new CommentStorage(adapter);

			await storage.saveComment(makeComment({ id: "new" }));

			expect(keptCopies(adapter, wrongShape)).toHaveLength(1);
			warn.mockRestore();
		});

		it("sets it aside once, not on every read", async () => {
			const warn = quiet();
			const adapter = new MemoryAdapter({ [sidecarFor(NOTE)]: truncated });
			const storage = new CommentStorage(adapter);

			await storage.getCommentsForFile(NOTE);
			await new CommentStorage(adapter).getCommentsForFile(NOTE);

			expect(keptCopies(adapter, truncated)).toHaveLength(1);
			warn.mockRestore();
		});

		it("drops the note from the index, whose counts described the lost comments", async () => {
			const warn = quiet();
			const adapter = new MemoryAdapter({
				[sidecarFor(NOTE)]: truncated,
				[`${STORAGE_DIR}/${INDEX_FILE}`]: JSON.stringify({
					[NOTE]: { hash: hashString(NOTE), threads: 2, open: 2 },
				}),
			});
			const storage = new CommentStorage(adapter);

			await storage.getCommentsForFile(NOTE);

			expect(await storage.getCommentSummaries()).toEqual([]);
			warn.mockRestore();
		});

		it("tells the owner which note it was and where the bytes were kept", async () => {
			const warn = quiet();
			const adapter = new MemoryAdapter({ [sidecarFor(NOTE)]: truncated });
			const reports: { filePath: string; keptAt: string }[] = [];
			const storage = new CommentStorage(adapter, {
				onUnreadable: (filePath, keptAt) => reports.push({ filePath, keptAt }),
			});

			await storage.getCommentsForFile(NOTE);
			await storage.getCommentsForFile(NOTE);

			expect(reports).toEqual([{ filePath: NOTE, keptAt: keptCopies(adapter, truncated)[0] }]);
			warn.mockRestore();
		});

		it("refuses to write over a sidecar the adapter could not read at all", async () => {
			// No text came back, so there is nothing to set aside: the file on disk is
			// the only copy, and a save must fail rather than replace it.
			class FailingRead extends MemoryAdapter {
				async read(path: string): Promise<string> {
					if (path === sidecarFor(NOTE)) throw new Error("EIO");
					return super.read(path);
				}
			}
			const warn = quiet();
			const original = JSON.stringify({ filePath: NOTE, comments: [makeComment({ id: "old" })] });
			const adapter = new FailingRead({ [sidecarFor(NOTE)]: original });
			const storage = new CommentStorage(adapter);

			expect(await storage.getCommentsForFile(NOTE)).toEqual([]);
			await expect(storage.saveComment(makeComment({ id: "new" }))).rejects.toThrow("EIO");
			expect(adapter.snapshot()[sidecarFor(NOTE)]).toBe(original);
			warn.mockRestore();
		});

		it("is announced with the note's name and where its text was kept", () => {
			const keptAt = `${STORAGE_DIR}/abc.json.unreadable-1`;
			const message = describeUnreadableSidecar("notes/deep/meeting.md", keptAt);
			expect(message).toContain("meeting");
			expect(message).not.toContain("notes/deep");
			expect(message).toContain(keptAt);
		});
	});

	describe("a write that does not finish", () => {
		const NOTE = "notes/meeting.md";
		const tmpFor = (filePath: string) => `${sidecarFor(filePath)}.tmp`;
		const sidecarWith = (...ids: string[]) =>
			JSON.stringify({ filePath: NOTE, comments: ids.map((id) => makeComment({ id })) });
		const idsOnDisk = async (adapter: MemoryAdapter) =>
			(await new CommentStorage(adapter).getCommentsForFile(NOTE)).map((c) => c.id);

		/** Dies partway through the next write under `armed`, as a crash or a full disk would. */
		class DyingWrite extends MemoryAdapter {
			armed: string | null = null;
			async write(path: string, content: string): Promise<void> {
				if (this.armed !== null && path.startsWith(this.armed)) {
					this.armed = null;
					await super.write(path, content.slice(0, Math.floor(content.length / 2)));
					throw new Error("write interrupted");
				}
				return super.write(path, content);
			}
		}

		it("runs against a fake adapter that refuses to rename onto a file, as Obsidian's does", async () => {
			// Measured on Obsidian 1.13.7 desktop: the rename throws and the target keeps
			// its content. The fake has to agree, or these tests prove a swap that
			// Obsidian would refuse.
			const adapter = new MemoryAdapter({ a: "1", b: "2" });
			await expect(adapter.rename("a", "b")).rejects.toThrow("Destination file already exists!");
			expect(adapter.snapshot()).toEqual({ a: "1", b: "2" });
		});

		it("leaves the previous comments readable when a save dies partway", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const adapter = new DyingWrite();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment({ id: "a" }));

			adapter.armed = sidecarFor(NOTE);
			await expect(storage.saveComment(makeComment({ id: "b" }))).rejects.toThrow(
				"write interrupted",
			);

			expect(await idsOnDisk(adapter)).toEqual(["a"]);
			warn.mockRestore();
		});

		it("moves a finished replacement into place when the crash came before the move", async () => {
			const replacement = sidecarWith("a");
			const adapter = new MemoryAdapter({ [tmpFor(NOTE)]: replacement });

			expect(await idsOnDisk(adapter)).toEqual(["a"]);
			expect(adapter.snapshot()[sidecarFor(NOTE)]).toBe(replacement);
			expect(await adapter.exists(tmpFor(NOTE))).toBe(false);
		});

		it("leaves no temporary file behind once a save lands over a partial one", async () => {
			const adapter = new MemoryAdapter({
				[sidecarFor(NOTE)]: sidecarWith("a"),
				[tmpFor(NOTE)]: '{ "filePath": "notes/meet',
			});

			await new CommentStorage(adapter).saveComment(makeComment({ id: "b" }));

			expect(await adapter.exists(tmpFor(NOTE))).toBe(false);
			expect(await idsOnDisk(adapter)).toEqual(["a", "b"]);
		});

		it("lets two notes save at once without their index writes colliding", async () => {
			// Each note writes the shared index through a temporary file; two at once
			// would each move the other's away if the index were not queued on its own.
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);

			await Promise.all([
				storage.saveComment(makeComment({ id: "a" })),
				storage.saveComment(makeComment({ id: "b", filePath: "notes/other.md" })),
			]);

			const summaries = await new CommentStorage(adapter).getCommentSummaries();
			expect(summaries.map((s) => s.filePath).sort()).toEqual([NOTE, "notes/other.md"]);
		});
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

// These calls come from independent UI events: a resolve tapped while a reply is
// still being sent, or an edit saved while a delete runs. Nothing but timing keeps
// them apart, so each test starts two at once and reads what landed on disk through
// a fresh store, because the cache could hide a write the file never got.
describe("overlapping mutations of one note", () => {
	const NOTE = "notes/meeting.md";
	const onDisk = async (adapter: MemoryAdapter, filePath = NOTE) =>
		new CommentStorage(adapter).getCommentsForFile(filePath);
	const ids = (comments: Comment[]) => comments.map((c) => c.id).sort();

	it("keeps both of two comments saved at once", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment({ id: "seed" }));

		await Promise.all([
			storage.saveComment(makeComment({ id: "a" })),
			storage.saveComment(makeComment({ id: "b" })),
		]);

		expect(ids(await onDisk(adapter))).toEqual(["a", "b", "seed"]);
	});

	it("keeps a resolve that overlaps a reply to the same thread", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		const root = makeComment({ id: "root" });
		await storage.saveComment(root);

		await Promise.all([
			storage.updateComment({ ...root, resolved: true }),
			storage.saveComment(makeComment({ id: "reply", parentId: "root" })),
		]);

		const stored = await onDisk(adapter);
		expect(ids(stored)).toEqual(["reply", "root"]);
		expect(stored.find((c) => c.id === "root")?.resolved).toBe(true);
	});

	it("keeps a comment saved while another is deleted", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment({ id: "gone" }));
		await storage.saveComment(makeComment({ id: "kept" }));

		await Promise.all([
			storage.deleteComment(NOTE, "gone"),
			storage.saveComment(makeComment({ id: "new" })),
		]);

		expect(ids(await onDisk(adapter))).toEqual(["kept", "new"]);
	});

	it("neither loses nor doubles a comment saved while the note's comments are taken", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment({ id: "a" }));

		const [taken] = await Promise.all([
			storage.takeComments(NOTE),
			storage.saveComment(makeComment({ id: "b" })),
		]);

		expect(ids([...taken, ...(await onDisk(adapter))])).toEqual(["a", "b"]);
	});

	it("keeps a comment saved while a restore runs", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment({ id: "old" }));
		const taken = await storage.takeComments(NOTE);

		await Promise.all([
			storage.restoreComments(NOTE, taken),
			storage.saveComment(makeComment({ id: "new" })),
		]);

		expect(ids(await onDisk(adapter))).toEqual(["new", "old"]);
	});

	it("keeps a comment saved on the target while a move writes to it", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment({ id: "moving" }));

		await Promise.all([
			storage.moveComments(NOTE, "notes/standup.md"),
			storage.saveComment(makeComment({ id: "local", filePath: "notes/standup.md" })),
		]);

		expect(ids(await onDisk(adapter, "notes/standup.md"))).toEqual(["local", "moving"]);
		expect(await onDisk(adapter)).toEqual([]);
	});

	it("does not let a slow first read put an old list back in the cache after a save", async () => {
		// Opening a note reads its sidecar. If a save lands while that read is still
		// in flight, the read resolves with the file as it was and must not replace
		// what the save cached: the next save would build on it and drop the first.
		class HeldRead extends MemoryAdapter {
			private held: Promise<void> | null = null;
			release: () => void = () => {};
			hold(): void {
				this.held = new Promise((resolve) => {
					this.release = resolve;
				});
			}
			async read(path: string): Promise<string> {
				const content = await super.read(path);
				const held = this.held;
				this.held = null;
				if (held) await held;
				return content;
			}
		}
		const adapter = new HeldRead();
		await new CommentStorage(adapter).saveComment(makeComment({ id: "seed" }));
		const storage = new CommentStorage(adapter);

		adapter.hold();
		const opening = storage.getCommentsForFile(NOTE);
		const saving = storage.saveComment(makeComment({ id: "first" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		adapter.release();
		await Promise.all([opening, saving]);
		await storage.saveComment(makeComment({ id: "second" }));

		expect(ids(await onDisk(adapter))).toEqual(["first", "second", "seed"]);
	});

	it("settles a rename undone while the first move is still running", async () => {
		// A move holds both notes, so two moves in opposite directions would each
		// wait on the note the other holds if they took them in call order.
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment({ id: "c1" }));

		const settled = await Promise.race([
			Promise.all([
				storage.moveComments(NOTE, "notes/renamed.md"),
				storage.moveComments("notes/renamed.md", NOTE),
			]).then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
		]);

		expect(settled).toBe(true);
		const everywhere = [...(await onDisk(adapter)), ...(await onDisk(adapter, "notes/renamed.md"))];
		expect(ids(everywhere)).toEqual(["c1"]);
	});
});

// A sidecar is not trusted input: it can be hand-edited, merged by a sync conflict,
// copied from another vault, or written by another version of the plugin.
describe("sidecar contents that do not fit the data model", () => {
	const NOTE = "notes/meeting.md";
	const sidecarOf = (comments: unknown[], filePath = NOTE) => JSON.stringify({ filePath, comments });
	const without = (value: object, key: string) =>
		Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
	const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});
	const keptFiles = (adapter: MemoryAdapter) =>
		Object.entries(adapter.snapshot()).filter(([path]) =>
			path.startsWith(`${sidecarFor(NOTE)}.invalid-`),
		);

	// Each breaks one field that the rest of the plugin reads without checking.
	const broken: [string, (c: Comment) => unknown][] = [
		["no anchor", (c) => without(c, "anchor")],
		["no id", (c) => without(c, "id")],
		["an empty id", (c) => ({ ...c, id: "" })],
		["content that is not text", (c) => ({ ...c, content: 42 })],
		["an anchor without its text hash", (c) => ({ ...c, anchor: without(c.anchor, "textHash") })],
		["a line hint that is not a number", (c) => ({ ...c, anchor: { ...c.anchor, lineHint: "3" } })],
		["a parent that is neither null nor an id", (c) => ({ ...c, parentId: 7 })],
		["a timestamp that is not a number", (c) => ({ ...c, createdAt: "yesterday" })],
		["a resolved flag that is not a boolean", (c) => ({ ...c, resolved: "yes" })],
		["an edit time that is not a number", (c) => ({ ...c, editedAt: "today" })],
		["the path of another note", (c) => ({ ...c, filePath: "notes/other.md" })],
	];

	it.each(broken)("sets aside a comment with %s, keeping the valid one beside it", async (_, breakIt) => {
		const warn = quiet();
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([makeComment({ id: "good" }), breakIt(makeComment({ id: "bad" }))]),
		});

		const loaded = await new CommentStorage(adapter).getCommentsForFile(NOTE);

		expect(loaded.map((c) => c.id)).toEqual(["good"]);
		warn.mockRestore();
	});

	it("still draws the valid threads of a note holding an invalid comment", async () => {
		const warn = quiet();
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([
				makeComment({ id: "good" }),
				without(makeComment({ id: "bad" }), "anchor"),
			]),
		});

		const loaded = await new CommentStorage(adapter).getCommentsForFile(NOTE);

		expect(buildThreads("hello world", loaded).map((t) => t.root.id)).toEqual(["good"]);
		warn.mockRestore();
	});

	it("accepts a comment with an edit time and one without", async () => {
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([makeComment({ id: "a", editedAt: 2000 }), makeComment({ id: "b" })]),
		});

		const loaded = await new CommentStorage(adapter).getCommentsForFile(NOTE);

		expect(loaded.map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("keeps what it set aside on disk, through the next save", async () => {
		const warn = quiet();
		const bad = without(makeComment({ id: "bad" }), "anchor");
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([makeComment({ id: "good" }), bad]),
		});
		const storage = new CommentStorage(adapter);

		await storage.getCommentsForFile(NOTE);
		await storage.saveComment(makeComment({ id: "new" }));

		const kept = keptFiles(adapter);
		expect(kept).toHaveLength(1);
		expect(JSON.parse(kept[0][1])).toEqual({ filePath: NOTE, comments: [bad] });
		const sidecar = JSON.parse(adapter.snapshot()[sidecarFor(NOTE)]);
		expect(sidecar.comments.map((c: Comment) => c.id)).toEqual(["good", "new"]);
		warn.mockRestore();
	});

	it("tells the owner once how many were set aside and where", async () => {
		const warn = quiet();
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([
				makeComment({ id: "good" }),
				without(makeComment({ id: "b1" }), "anchor"),
				{ nonsense: true },
			]),
		});
		const reports: [string, number, string][] = [];
		const onInvalid = (filePath: string, count: number, keptAt: string) =>
			reports.push([filePath, count, keptAt]);

		await new CommentStorage(adapter, { onInvalid }).getCommentsForFile(NOTE);
		await new CommentStorage(adapter, { onInvalid }).getCommentsForFile(NOTE);

		expect(reports).toEqual([[NOTE, 2, keptFiles(adapter)[0][0]]]);
		warn.mockRestore();
	});

	it("removes the sidecar and its index entry when nothing in it is valid", async () => {
		const warn = quiet();
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([{ nonsense: true }]),
			[`${STORAGE_DIR}/${INDEX_FILE}`]: JSON.stringify({
				[NOTE]: { hash: hashString(NOTE), threads: 1, open: 1 },
			}),
		});
		const storage = new CommentStorage(adapter);

		expect(await storage.getCommentsForFile(NOTE)).toEqual([]);

		expect(await adapter.exists(sidecarFor(NOTE))).toBe(false);
		expect(keptFiles(adapter)).toHaveLength(1);
		expect(await storage.getCommentSummaries()).toEqual([]);
		warn.mockRestore();
	});

	it("does not index a sidecar under a note its file is not named after", async () => {
		// A copied or hand-renamed folder: the file carries one note's name and claims
		// another. Indexed as it claims, the all-notes view would list a note whose own
		// sidecar does not exist.
		const adapter = new MemoryAdapter({
			[sidecarFor("notes/b.md")]: sidecarOf([makeComment({ filePath: "notes/a.md" })], "notes/a.md"),
			[sidecarFor("notes/c.md")]: sidecarOf([makeComment({ filePath: "notes/c.md" })], "notes/c.md"),
		});
		// Seeding files does not create their folder, and a rebuild with no folder
		// returns before reading anything: this test would pass without scanning.
		await adapter.mkdir(STORAGE_DIR);

		const summaries = await new CommentStorage(adapter).getCommentSummaries();
		expect(summaries.map((s) => s.filePath)).toEqual(["notes/c.md"]);
	});

	it("counts only valid comments when rebuilding the index", async () => {
		// The vault view draws its counts from the index alone, and opening the note
		// will set the invalid ones aside: counting them would promise threads it
		// never shows.
		const warn = quiet();
		const adapter = new MemoryAdapter({
			[sidecarFor(NOTE)]: sidecarOf([
				makeComment({ id: "good" }),
				without(makeComment({ id: "bad" }), "anchor"),
			]),
		});
		await adapter.mkdir(STORAGE_DIR);

		expect(await new CommentStorage(adapter).getCommentSummaries()).toEqual([
			{ filePath: NOTE, threads: 1, open: 1 },
		]);
		warn.mockRestore();
	});

	it("is announced with the count, the note's name and where they were kept", () => {
		const keptAt = `${STORAGE_DIR}/abc.json.invalid-1`;
		const message = describeInvalidComments("notes/deep/meeting.md", 2, keptAt);
		expect(message).toContain("2 comments");
		expect(message).toContain("meeting");
		expect(message).not.toContain("notes/deep");
		expect(message).toContain(keptAt);
		expect(describeInvalidComments(NOTE, 1, keptAt)).toContain("1 comment ");
	});
});
