import { describe, it, expect, beforeEach } from "vitest";
import type { TAbstractFile } from "obsidian";
import { CommentStorage } from "../../src/storage";
import { NoteEvents, followStorageRename, forgetDeletedStorage } from "../../src/vault-events";
import {
	describeStorageDeleted,
	describeStorageFollowed,
	describeStorageUnreachable,
} from "../../src/note-moves";
import { TFile, TFolder, clearNotices, notices } from "../helpers/obsidian-stub";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

const DIR = "margin-comments";
const NOTE = "notes/meeting.md";
const CONFIG_DIR = ".obsidian";

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
		content: "a comment",
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

// The stub carries only what src/ reaches for; tsc checks against the real types.
const file = (path: string) => new TFile(path) as unknown as TAbstractFile;
const folder = (path: string) => new TFolder(path) as unknown as TAbstractFile;

/** Everything NoteEvents asked the store for, by method name. */
function counting(storage: CommentStorage): { storage: CommentStorage; calls: string[] } {
	const calls: string[] = [];
	const spy = new Proxy(storage, {
		get(target, key, receiver) {
			const value: unknown = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			calls.push(String(key));
			return (value as (...args: unknown[]) => unknown).bind(target);
		},
	});
	return { storage: spy, calls };
}

/** Wired as main.ts wires it, with the setting kept in a local. */
function setup(seed: Record<string, string> = {}) {
	const adapter = new MemoryAdapter(seed);
	const real = new CommentStorage(adapter, { dir: DIR });
	const { storage, calls } = counting(real);
	const settings = { storageFolder: DIR };
	let saves = 0;
	const notes = new NoteEvents({
		storage,
		orphanedBehavior: () => "delete",
		refresh: () => Promise.resolve(),
		readNote: () => Promise.resolve(null),
		fuzzyThreshold: () => 0.3,
		storageDir: () => real.dir,
		onStorageFolderRenamed: (to) =>
			followStorageRename(real, to, CONFIG_DIR, (dir) => {
				settings.storageFolder = dir;
				saves++;
				return Promise.resolve();
			}),
		onStorageFolderDeleted: async () => forgetDeletedStorage(real),
	});
	return { adapter, storage: real, calls, settings, notes, saves: () => saves };
}

/** What Obsidian does on disk before it fires the rename: every file changes prefix. */
async function renameOnDisk(adapter: MemoryAdapter, from: string, to: string): Promise<void> {
	for (const [path, text] of Object.entries(adapter.snapshot())) {
		if (!path.startsWith(`${from}/`)) continue;
		await adapter.write(`${to}/${path.slice(from.length + 1)}`, text);
		await adapter.remove(path);
	}
	await adapter.rmdir(from, true);
}

const sidecarIn = (dir: string, filePath: string) => `${dir}/${hashString(filePath)}.json`;

beforeEach(() => clearNotices());

describe("the store's own files under a visible storage folder", () => {
	const own = [
		`${DIR}/${hashString(NOTE)}.json`,
		`${DIR}/${hashString(NOTE)}.json.tmp`,
		`${DIR}/_index.json`,
		`${DIR}/_index.json.tmp`,
		`${DIR}/held/${hashString(NOTE)}.json`,
		// Not ours, but inside the folder all the same: never a note to follow.
		`${DIR}/stray.md`,
	];

	it.each(own)("a rename of %s never reaches the store", async (path) => {
		const { notes, calls } = setup();
		await notes.followRename(path, path.replace(/\.tmp$/, ""));
		await notes.followRename(`${path}.tmp`, path);
		expect(calls).toEqual([]);
	});

	it.each(own)("a create of %s never reaches the store", async (path) => {
		const { notes, calls } = setup();
		await notes.followCreate(file(path));
		expect(calls).toEqual([]);
	});

	it.each(own)("a delete of %s never reaches the store", async (path) => {
		const { notes, calls } = setup();
		await notes.followDelete(file(path));
		expect(calls).toEqual([]);
	});

	it("a note moved into the folder is not followed there", async () => {
		const { notes, calls } = setup();
		await notes.followRename(NOTE, `${DIR}/meeting.md`);
		expect(calls).toEqual([]);
	});

	it("a sibling whose name only starts with the folder's is still a note", async () => {
		const { notes, storage } = setup();
		await storage.saveComment(makeComment(`${DIR}-archive/a.md`, "c1"));
		await notes.followRename(`${DIR}-archive/a.md`, `${DIR}-archive/b.md`);
		expect(await storage.getCommentsForFile(`${DIR}-archive/b.md`)).toHaveLength(1);
	});

	it("raises no Notice on a plain save", async () => {
		const { notes, storage } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		const sidecar = sidecarIn(DIR, NOTE);
		await notes.followCreate(file(`${sidecar}.tmp`));
		await notes.followRename(`${sidecar}.tmp`, sidecar);
		expect(notices).toEqual([]);
	});
});

describe("a note renamed outside the storage folder", () => {
	it("still takes its comments along", async () => {
		const { notes, storage, adapter } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));

		await notes.followRename(NOTE, "notes/standup.md");

		expect(await adapter.exists(sidecarIn(DIR, "notes/standup.md"))).toBe(true);
		expect(await adapter.exists(sidecarIn(DIR, NOTE))).toBe(false);
	});
});

describe("the storage folder renamed by the user (D4)", () => {
	it("moves the setting and the store to the new name", async () => {
		const { notes, storage, adapter, settings, saves } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		await renameOnDisk(adapter, DIR, "comments");

		await notes.followRename(DIR, "comments");

		expect(settings.storageFolder).toBe("comments");
		expect(saves()).toBe(1);
		expect(storage.dir).toBe("comments");
		expect(await storage.getCommentsForFile(NOTE)).toHaveLength(1);
		expect(notices).toEqual([
			{ message: describeStorageFollowed("comments"), duration: undefined },
		]);
	});

	it("writes the next comment into the new folder, not the old one", async () => {
		const { notes, storage, adapter } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		await renameOnDisk(adapter, DIR, "comments");
		await notes.followRename(DIR, "comments");

		await storage.saveComment(makeComment("other.md", "c2"));

		expect(await adapter.exists(sidecarIn("comments", "other.md"))).toBe(true);
		expect(await adapter.exists(DIR)).toBe(false);
	});

	it("ignores the per-file renames that follow the folder's", async () => {
		const { notes, storage, adapter, calls } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		await renameOnDisk(adapter, DIR, "comments");
		const sidecar = `${hashString(NOTE)}.json`;

		await notes.followRename(DIR, "comments");
		calls.length = 0;
		await notes.followRename(`${DIR}/${sidecar}`, `comments/${sidecar}`);

		expect(calls).toEqual([]);
	});

	it.each([
		["a/margin-comments", "moved into a subfolder"],
		[CONFIG_DIR, "the config folder"],
		[".trash", "the trash"],
	])("keeps the old setting and warns when moved to %s (%s)", async (to) => {
		const { notes, storage, adapter, settings, saves } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		await renameOnDisk(adapter, DIR, to);

		await notes.followRename(DIR, to);

		expect(settings.storageFolder).toBe(DIR);
		expect(saves()).toBe(0);
		expect(storage.dir).toBe(DIR);
		expect(notices).toEqual([{ message: describeStorageUnreachable(to, DIR), duration: 0 }]);
		// Forgotten, so a stale card cannot be edited back into the old path.
		expect(await storage.getCommentsForFile(NOTE)).toEqual([]);
	});
});

describe("the storage folder deleted by the user (D5)", () => {
	it("raises a Notice that stays and writes nothing", async () => {
		const { notes, storage, adapter } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		await adapter.rmdir(DIR, true);
		const written = adapter.writes.length;

		// Innermost first, as Obsidian fires them.
		await notes.followDelete(file(sidecarIn(DIR, NOTE)));
		await notes.followDelete(file(`${DIR}/_index.json`));
		await notes.followDelete(folder(DIR));

		expect(notices).toEqual([{ message: describeStorageDeleted(DIR), duration: 0 }]);
		expect(adapter.writes.length).toBe(written);
		expect(await adapter.exists(DIR)).toBe(false);
		expect(await storage.getCommentsForFile(NOTE)).toEqual([]);
		expect(await storage.getCommentSummaries()).toEqual([]);
		expect(await adapter.exists(DIR)).toBe(false);
	});

	it("is created again by the next new comment", async () => {
		const { notes, storage, adapter } = setup();
		await storage.saveComment(makeComment(NOTE, "c1"));
		await adapter.rmdir(DIR, true);
		await notes.followDelete(folder(DIR));

		await storage.saveComment(makeComment(NOTE, "c2"));

		expect(await adapter.exists(sidecarIn(DIR, NOTE))).toBe(true);
		// Only the new one: the deleted comment stays in the trash, not resurrected from memory.
		expect((await storage.getCommentsForFile(NOTE)).map((c) => c.id)).toEqual(["c2"]);
	});
});
