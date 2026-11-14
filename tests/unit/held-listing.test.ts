import { describe, it, expect, vi } from "vitest";
import { CommentStorage, HELD_DIR, STORAGE_DIR } from "../../src/storage";
import { describeHeldEntry } from "../../src/deleted-notes";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

const NOTE = "notes/ext.md";
const OTHER = "notes/other.md";
const TARGET = "notes/target.md";

const heldFor = (filePath: string) => `${STORAGE_DIR}/${HELD_DIR}/${hashString(filePath)}.json`;

function makeComment(filePath: string, id: string, extra: Partial<Comment> = {}): Comment {
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
		...extra,
	};
}

describe("listing what is held (#432)", () => {
	it("is empty when nothing is held, and when there is no held folder", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		expect(await storage.listHeld()).toEqual([]);
	});

	it("names each entry by its old path, open threads and newest update", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		await storage.saveComment(makeComment(NOTE, "r1"));
		await storage.saveComment(makeComment(NOTE, "r2", { resolved: true, updatedAt: 3000 }));
		await storage.saveComment(makeComment(NOTE, "r3", { parentId: "r1", updatedAt: 2000 }));
		await storage.saveComment(makeComment(OTHER, "o1"));
		await storage.holdComments(NOTE);
		await storage.holdComments(OTHER);

		const entries = await storage.listHeld();

		expect(entries).toHaveLength(2);
		expect(entries.find((e) => e.filePath === NOTE)).toEqual({
			filePath: NOTE,
			openThreads: 1,
			updatedAt: 3000,
		});
		expect(entries.find((e) => e.filePath === OTHER)?.openThreads).toBe(1);
	});

	it("skips a held file that cannot be read instead of failing the list", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		await storage.holdComments(NOTE);
		await adapter.write(`${STORAGE_DIR}/${HELD_DIR}/junk.json`, "not json");

		expect((await storage.listHeld()).map((e) => e.filePath)).toEqual([NOTE]);
	});

	it("reads only held files, never a note's sidecar", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(OTHER, "x1"));
		await storage.saveComment(makeComment(NOTE, "c1"));
		await storage.holdComments(NOTE);
		const read = vi.spyOn(adapter, "read");

		await storage.listHeld();

		expect(read).toHaveBeenCalled();
		expect(read.mock.calls.every(([path]) => path.includes(`/${HELD_DIR}/`))).toBe(true);
	});
});

describe("restoring a held entry to another note (#432)", () => {
	it("moves every comment with its filePath rewritten, and removes the held file", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(NOTE, "c1"));
		await storage.saveComment(makeComment(NOTE, "c2", { parentId: "c1" }));
		await storage.holdComments(NOTE);

		const count = await storage.restoreHeld(NOTE, TARGET);

		expect(count).toBe(2);
		const restored = await storage.getCommentsForFile(TARGET);
		expect(restored.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
		expect(restored.every((c) => c.filePath === TARGET)).toBe(true);
		expect(await adapter.exists(heldFor(NOTE))).toBe(false);
		expect(await storage.listHeld()).toEqual([]);
	});

	it("restores nothing when the entry is gone", async () => {
		const storage = new CommentStorage(new MemoryAdapter());
		expect(await storage.restoreHeld(NOTE, TARGET)).toBe(0);
		expect(await storage.getCommentsForFile(TARGET)).toEqual([]);
	});
});

describe("describeHeldEntry (#432)", () => {
	it("names the old path, the open thread count and the date", () => {
		const label = describeHeldEntry(NOTE, 2, Date.UTC(2026, 10, 14, 12));
		expect(label).toContain(NOTE);
		expect(label).toContain("2 open threads");
		expect(label).toContain("2026-11-14");
		expect(describeHeldEntry("a.md", 1, 0)).toContain("1 open thread,");
	});
});
