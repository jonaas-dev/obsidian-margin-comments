import { describe, it, expect } from "vitest";
import { CommentStorage, FORMAT_VERSION, INDEX_FILE, STORAGE_DIR } from "../../src/storage";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

/**
 * A sidecar or the index changing on disk under a running plugin: a sync client
 * (Git, iCloud, Dropbox, Syncthing) delivering what another device wrote (#260).
 */

const NOTE = "notes/meeting.md";
const OTHER = "notes/other-device.md";
const INDEX = `${STORAGE_DIR}/${INDEX_FILE}`;
const sidecarFor = (filePath: string): string => `${STORAGE_DIR}/${hashString(filePath)}.json`;

function comment(id: string, filePath = NOTE, overrides: Partial<Comment> = {}): Comment {
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
		content: `body of ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

/** Writes a file the way a sync client does: straight to disk, past the plugin. */
async function deliver(adapter: MemoryAdapter, path: string, value: unknown): Promise<void> {
	await adapter.write(path, JSON.stringify(value, null, 2));
}

const onDisk = (adapter: MemoryAdapter, path: string): { comments: Comment[] } =>
	JSON.parse(adapter.snapshot()[path]);

const indexedNotes = (adapter: MemoryAdapter): string[] =>
	Object.keys(JSON.parse(adapter.snapshot()[INDEX]).notes).sort();

describe("changes that reach the storage folder from outside", () => {
	it("keeps a comment another device added when this one changes the note", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));

		await deliver(adapter, sidecarFor(NOTE), {
			version: FORMAT_VERSION,
			filePath: NOTE,
			comments: [comment("local-1"), comment("external-1")],
		});
		await storage.saveComment(comment("local-2"));

		expect(onDisk(adapter, sidecarFor(NOTE)).comments.map((c) => c.id)).toEqual([
			"local-1",
			"external-1",
			"local-2",
		]);
	});

	it("does not bring back a comment another device deleted", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));
		await storage.saveComment(comment("deleted-elsewhere"));

		await deliver(adapter, sidecarFor(NOTE), {
			version: FORMAT_VERSION,
			filePath: NOTE,
			comments: [comment("local-1")],
		});
		await storage.updateComment({ ...comment("local-1"), resolved: true });

		expect(onDisk(adapter, sidecarFor(NOTE)).comments.map((c) => c.id)).toEqual(["local-1"]);
	});

	it("keeps a note another device added to the index when this one writes it", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));
		await storage.getCommentSummaries();

		await deliver(adapter, sidecarFor(OTHER), {
			version: FORMAT_VERSION,
			filePath: OTHER,
			comments: [comment("external-1", OTHER)],
		});
		const index = JSON.parse(adapter.snapshot()[INDEX]);
		index.notes[OTHER] = { hash: hashString(OTHER), threads: 1, open: 1 };
		await deliver(adapter, INDEX, index);

		await storage.saveComment(comment("local-2"));

		expect(indexedNotes(adapter)).toEqual([NOTE, OTHER].sort());
	});

	it("lists a note whose sidecar arrived without an index entry", async () => {
		// The two files sync independently, so the sidecar can land while the index
		// that lists it is still on its way, or is lost to a conflict.
		const adapter = new MemoryAdapter();
		await new CommentStorage(adapter).saveComment(comment("local-1"));
		await deliver(adapter, sidecarFor(OTHER), {
			version: FORMAT_VERSION,
			filePath: OTHER,
			comments: [comment("external-1", OTHER), comment("external-2", OTHER, { resolved: true })],
		});

		const summaries = await new CommentStorage(adapter).getCommentSummaries();

		expect(summaries.find((s) => s.filePath === OTHER)).toEqual({
			filePath: OTHER,
			threads: 2,
			open: 1,
		});
	});

	it("still reads no sidecar to summarise a vault whose index is complete", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));
		await storage.saveComment(comment("other-1", OTHER));

		adapter.reads.length = 0;
		await new CommentStorage(adapter).getCommentSummaries();

		expect(adapter.reads).toEqual([INDEX]);
	});

	it("shows a synced comment once told the sidecar changed", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));

		await deliver(adapter, sidecarFor(NOTE), {
			version: FORMAT_VERSION,
			filePath: NOTE,
			comments: [comment("local-1"), comment("external-1")],
		});
		expect(await storage.changedOnDisk(sidecarFor(NOTE))).toBe(true);

		expect((await storage.getCommentsForFile(NOTE)).map((c) => c.id)).toEqual([
			"local-1",
			"external-1",
		]);
	});

	it("lists a synced note in the vault view once told its sidecar arrived", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));
		await storage.getCommentSummaries();

		await deliver(adapter, sidecarFor(OTHER), {
			version: FORMAT_VERSION,
			filePath: OTHER,
			comments: [comment("external-1", OTHER)],
		});
		expect(await storage.changedOnDisk(sidecarFor(OTHER))).toBe(true);

		expect((await storage.getCommentSummaries()).map((s) => s.filePath).sort()).toEqual(
			[NOTE, OTHER].sort(),
		);
	});

	it("does not count its own writes as a change", async () => {
		// Every save fires the same file event a sync does; answering each one with
		// a repaint would redraw everything twice per comment.
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(comment("local-1"));
		await storage.getCommentSummaries();

		expect(await storage.changedOnDisk(sidecarFor(NOTE))).toBe(false);
		expect(await storage.changedOnDisk(INDEX)).toBe(false);
		expect(await storage.changedOnDisk(`${sidecarFor(NOTE)}.tmp`)).toBe(false);
		expect(await storage.changedOnDisk("notes/meeting.md")).toBe(false);
	});
});
