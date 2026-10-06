import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommentStorage, HELD_DIR, STORAGE_DIR } from "../../src/storage";
import { NoteEvents } from "../../src/vault-events";
import type { TAbstractFile } from "obsidian";
import { TFile, clearNotices, noticeMessages } from "../helpers/obsidian-stub";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

const NOTE = "notes/ext.md";
const RENAMED = "notes/ext-renamed.md";

const heldFor = (filePath: string) => `${STORAGE_DIR}/${HELD_DIR}/${hashString(filePath)}.json`;
const sidecarFor = (filePath: string) => `${STORAGE_DIR}/${hashString(filePath)}.json`;

function makeComment(filePath: string, id: string): Comment {
	return {
		id,
		filePath,
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
		content: `comment ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

// The stub carries only what src/ reaches for; tsc checks against the real types,
// which also declare vault, name and parent.
const file = (path: string) => new TFile(path) as unknown as TAbstractFile;

const events = (storage: CommentStorage) =>
	new NoteEvents({
		storage,
		orphanedBehavior: () => "delete",
		refresh: () => Promise.resolve(),
		readNote: () => Promise.resolve(null),
		fuzzyThreshold: () => 0.3,
	});

describe("comments held for a note that went away", () => {
	it("are on disk, not only in memory", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));

		await storage.holdComments(NOTE);

		expect(await adapter.exists(heldFor(NOTE))).toBe(true);
		// Off the note, so the all-notes view does not list a note that is gone.
		expect(await adapter.exists(sidecarFor(NOTE))).toBe(false);
	});

	it("survive a restart", async () => {
		// The whole point of #259: a note renamed outside Obsidian never comes back
		// at the path it left, so a session-long hold loses the comments for good.
		const adapter = new MemoryAdapter();
		const before = new CommentStorage(adapter);
		await before.saveComment(makeComment(NOTE, "c1"));
		await before.holdComments(NOTE);

		// A second storage over the same files is this plugin starting again.
		const after = new CommentStorage(adapter);
		expect(await after.releaseComments(NOTE)).toHaveLength(1);
	});

	it("stop being held once released", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		await storage.holdComments(NOTE);

		await storage.releaseComments(NOTE);

		expect(await adapter.exists(heldFor(NOTE))).toBe(false);
		expect(await storage.releaseComments(NOTE)).toBeNull();
	});

	it("say nothing is held for a note that never was", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		expect(await storage.releaseComments("notes/never.md")).toBeNull();
	});

	it("merge a second hold rather than duplicating", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		await storage.holdComments(NOTE);
		// Deleted twice in one session means it came back in between.
		await storage.restoreComments(NOTE, [makeComment(NOTE, "c1"), makeComment(NOTE, "c2")]);
		await storage.holdComments(NOTE);

		expect(await storage.releaseComments(NOTE)).toHaveLength(2);
	});

	it("are not reconciled into the index as a note of their own", async () => {
		// isSidecar only recognises a .json directly in STORAGE_DIR; a held file in
		// the subfolder must not become a note in the all-notes view.
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		await storage.holdComments(NOTE);

		expect(await storage.getCommentSummaries()).toEqual([]);
	});
});

describe("a note renamed outside Obsidian", () => {
	it("keeps its comments, which a delete used to take off disk", async () => {
		clearNotices();
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		const notes = events(storage);

		// The order Obsidian reports: create for the new path first, delete second.
		await notes.followCreate(file(RENAMED));
		await notes.followDelete(file(NOTE));

		// Still attached to the old path — re-attaching is #289 — but on disk, so
		// closing Obsidian no longer ends them.
		expect(await adapter.exists(heldFor(NOTE))).toBe(true);
		const restarted = new CommentStorage(adapter);
		expect(await restarted.releaseComments(NOTE)).toHaveLength(1);
		expect(noticeMessages.join(" ")).toContain("ext");
	});

	it("gives them straight back when the note returns to its old path", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		const notes = events(storage);

		await notes.followDelete(file(NOTE));
		await notes.followCreate(file(NOTE));

		expect(await storage.getCommentsForFile(NOTE)).toHaveLength(1);
		expect(await adapter.exists(heldFor(NOTE))).toBe(false);
	});
});

describe("pairing a create and a delete that are really a move", () => {
	/** A store with one commented note, and a host that can read the vault given here. */
	async function vaultWith(files: Record<string, string>, commented: string) {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(commented, "c1"));
		const notes = new NoteEvents({
			storage,
			orphanedBehavior: () => "delete",
			refresh: () => Promise.resolve(),
			readNote: (filePath) => Promise.resolve(files[filePath] ?? null),
			fuzzyThreshold: () => 0.3,
		});
		return { storage, notes, adapter };
	}

	beforeEach(() => clearNotices());

	it("hands the comments to the note the text moved to", async () => {
		// The order Obsidian reports for an external rename: create, then delete.
		const text = "hello there, this is the note's only line";
		const { storage, notes } = await vaultWith({ [RENAMED]: text }, NOTE);

		await notes.followCreate(file(RENAMED));
		await notes.followDelete(file(NOTE));

		expect(await storage.getCommentsForFile(RENAMED)).toHaveLength(1);
		expect(await storage.releaseComments(NOTE)).toBeNull();
		expect(noticeMessages.join(" ")).toContain("moved with");
	});

	it("rewrites the comments' own filePath, not just where they are filed", async () => {
		const text = "hello there, this is the note's only line";
		const { storage, notes } = await vaultWith({ [RENAMED]: text }, NOTE);

		await notes.followCreate(file(RENAMED));
		await notes.followDelete(file(NOTE));

		const [moved] = await storage.getCommentsForFile(RENAMED);
		// A comment whose filePath still named the old note would be filtered out
		// as not belonging the next time the sidecar was read.
		expect(moved.filePath).toBe(RENAMED);
	});

	it("never pairs a note that does not hold the comments", async () => {
		// The case timing cannot rule out: a file saved and a different one deleted
		// within the same 100 ms. Measured on #289 at 109 ms apart, against 103 ms
		// for a real rename.
		const { storage, notes } = await vaultWith({ "notes/unrelated.md": "nothing alike here" }, NOTE);

		await notes.followCreate(file("notes/unrelated.md"));
		await notes.followDelete(file(NOTE));

		expect(await storage.getCommentsForFile("notes/unrelated.md")).toHaveLength(0);
		// Held, as before: recoverable, which a wrong guess is not.
		expect(await storage.releaseComments(NOTE)).toHaveLength(1);
	});

	it("refuses to choose when two notes both fit", async () => {
		const text = "hello there, this is the note's only line";
		const { storage, notes } = await vaultWith({ "a/copy.md": text, "b/copy.md": text }, NOTE);

		await notes.followCreate(file("a/copy.md"));
		await notes.followCreate(file("b/copy.md"));
		await notes.followDelete(file(NOTE));

		expect(await storage.releaseComments(NOTE)).toHaveLength(1);
	});

	it("does not pair with a note created long before", async () => {
		const text = "hello there, this is the note's only line";
		const { storage, notes } = await vaultWith({ [RENAMED]: text }, NOTE);

		await notes.followCreate(file(RENAMED));
		// Older than the window: a note that happens to match, created minutes ago,
		// is not evidence that this delete was a move.
		vi.setSystemTime(Date.now() + 10_000);
		await notes.followDelete(file(NOTE));
		vi.useRealTimers();

		expect(await storage.releaseComments(NOTE)).toHaveLength(1);
	});
});
