import { describe, it, expect } from "vitest";
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
