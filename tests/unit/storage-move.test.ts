import { describe, it, expect } from "vitest";
import {
	CommentStorage,
	FORMAT_VERSION,
	HELD_DIR,
	INDEX_FILE,
	STORAGE_DIR,
	StorageMoveError,
} from "../../src/storage";
import { mergeComments } from "../../src/storage-move";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

const TARGET = "Comments";
const NOTE = "notes/a.md";
const OTHER = "notes/b.md";

function makeComment(id: string, filePath = NOTE, overrides: Partial<Comment> = {}): Comment {
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
		...overrides,
	};
}

const sidecarIn = (dir: string, filePath: string) => `${dir}/${hashString(filePath)}.json`;
const heldIn = (dir: string, filePath: string) => `${dir}/${HELD_DIR}/${hashString(filePath)}.json`;
const sidecarText = (filePath: string, comments: unknown[], version = FORMAT_VERSION) =>
	JSON.stringify({ version, filePath, comments }, null, 2);

function under(adapter: MemoryAdapter, dir: string): string[] {
	return Object.keys(adapter.snapshot()).filter((path) => path.startsWith(`${dir}/`));
}

async function idsIn(adapter: MemoryAdapter, path: string): Promise<Array<[string, string]>> {
	const { comments } = JSON.parse(await adapter.read(path)) as { comments: Comment[] };
	return comments.map((c) => [c.id, c.content]);
}

/** Throws on the chosen write into the target, once, like a disk filling up mid-copy. */
class FailingWrite extends MemoryAdapter {
	failOn = 2;
	private count = 0;
	async write(path: string, content: string): Promise<void> {
		if (path.startsWith(`${TARGET}/`) && ++this.count === this.failOn) {
			throw new Error("ENOSPC");
		}
		return super.write(path, content);
	}
}

/** Stores something other than what it was given, which only a read-back can catch. */
class CorruptingWrite extends MemoryAdapter {
	async write(path: string, content: string): Promise<void> {
		return super.write(path, path.startsWith(`${TARGET}/`) ? content.slice(1) : content);
	}
}

/** Every call takes a real turn of the event loop, as a disk does, so work can interleave. */
class SlowAdapter extends MemoryAdapter {
	/** Called once, on the first write into the target: the move is then mid-copy. */
	onCopy: () => void = () => undefined;
	private tick = () => new Promise((resolve) => setTimeout(resolve, 0));
	async read(path: string): Promise<string> {
		await this.tick();
		return super.read(path);
	}
	async write(path: string, content: string): Promise<void> {
		if (path.startsWith(`${TARGET}/`)) {
			this.onCopy();
			this.onCopy = () => undefined;
		}
		await this.tick();
		return super.write(path, content);
	}
}

/**
 * Rewrites a source sidecar while the move reads its copies back, the way Sync can
 * deliver another device's change between the copy and the delete.
 */
class SyncDuringMove extends MemoryAdapter {
	deliveries = 1;
	private delivered = 0;
	constructor(private readonly deliver: (n: number) => [path: string, text: string]) {
		super();
	}
	async read(path: string): Promise<string> {
		if (path.startsWith(`${TARGET}/`) && this.delivered < this.deliveries) {
			const [at, text] = this.deliver(++this.delivered);
			await super.write(at, text);
		}
		return super.read(path);
	}
}

/** Dies after the first source file is removed, like Obsidian closing mid-cleanup. */
class DyingRemove extends MemoryAdapter {
	armed = false;
	private removed = 0;
	async remove(path: string): Promise<void> {
		if (this.armed && path.startsWith(`${STORAGE_DIR}/`) && ++this.removed === 2) {
			throw new Error("killed");
		}
		return super.remove(path);
	}
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(StorageMoveError);
	return (error as StorageMoveError).reason;
}

describe("moving comments to another storage folder", () => {
	it("switches an empty store without writing anything", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);

		expect(await storage.moveTo(TARGET)).toEqual({
			moved: 0,
			merged: 0,
			keptBoth: 0,
			leftInSource: [],
		});

		expect(storage.dir).toBe(TARGET);
		expect(adapter.writes).toEqual([]);
	});

	it("carries sidecars, held and set-aside files, then deletes the source", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));
		await storage.saveComment(makeComment("b1", OTHER));
		await storage.saveComment(makeComment("h1", "notes/gone.md"));
		await storage.holdComments("notes/gone.md");
		const setAside = `${STORAGE_DIR}/${hashString("x")}.json.invalid-123`;
		await adapter.write(setAside, "kept text");
		const before = adapter.snapshot();

		const result = await storage.moveTo(TARGET);

		expect(result).toEqual({ moved: 4, merged: 0, keptBoth: 0, leftInSource: [] });
		expect(under(adapter, STORAGE_DIR)).toEqual([]);
		expect(await adapter.exists(STORAGE_DIR)).toBe(false);
		const after = adapter.snapshot();
		for (const path of [sidecarIn(STORAGE_DIR, NOTE), sidecarIn(STORAGE_DIR, OTHER)]) {
			expect(after[path.replace(STORAGE_DIR, TARGET)]).toBe(before[path]);
		}
		expect(after[`${TARGET}/${hashString("x")}.json.invalid-123`]).toBe("kept text");
		expect(await storage.releaseComments("notes/gone.md")).toHaveLength(1);
		expect(await storage.countSetAside()).toEqual({ count: 1, folder: TARGET });
		expect(await storage.getCommentsForFile(NOTE)).toHaveLength(1);
		expect((await storage.getCommentSummaries()).map((s) => s.filePath).sort()).toEqual([
			NOTE,
			OTHER,
		]);
	});

	it("writes later changes to the new folder", async () => {
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));
		await storage.moveTo(TARGET);

		await storage.saveComment(makeComment("a2"));

		expect(under(adapter, STORAGE_DIR)).toEqual([]);
		expect((await idsIn(adapter, sidecarIn(TARGET, NOTE))).map(([id]) => id)).toEqual([
			"a1",
			"a2",
		]);
	});

	it("finishes queued changes first and holds new ones until it is done", async () => {
		const adapter = new SlowAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));
		await storage.saveComment(makeComment("b1", OTHER));

		let during: Promise<void> = Promise.resolve();
		let copyStartedAt = -1;
		adapter.onCopy = () => {
			copyStartedAt = adapter.writes.length;
			during = storage.saveComment(makeComment("a3"));
		};

		const queued = storage.saveComment(makeComment("a2"));
		const held = storage.holdComments(OTHER);
		await storage.moveTo(TARGET);
		await Promise.all([queued, held, during]);

		// A change asked for mid-copy waits for the switch, so it never writes the source.
		expect(copyStartedAt).toBeGreaterThan(0);
		expect(
			adapter.writes.slice(copyStartedAt).filter((p) => p.startsWith(STORAGE_DIR)),
		).toEqual([]);
		expect(under(adapter, STORAGE_DIR)).toEqual([]);
		expect((await idsIn(adapter, sidecarIn(TARGET, NOTE))).map(([id]) => id)).toEqual([
			"a1",
			"a2",
			"a3",
		]);
		expect(await adapter.exists(heldIn(TARGET, OTHER))).toBe(true);
		expect(await adapter.exists(sidecarIn(TARGET, OTHER))).toBe(false);
	});

	it("keeps a change that reaches the source after it was copied", async () => {
		const source = sidecarIn(STORAGE_DIR, NOTE);
		const adapter = new SyncDuringMove(() => [
			source,
			sidecarText(NOTE, [makeComment("a1"), makeComment("synced")]),
		]);
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));

		const result = await storage.moveTo(TARGET);

		expect((await idsIn(adapter, sidecarIn(TARGET, NOTE))).map(([id]) => id)).toEqual([
			"a1",
			"synced",
		]);
		expect(result.leftInSource).toEqual([]);
		expect(await adapter.exists(STORAGE_DIR)).toBe(false);
	});

	it("leaves a source that keeps changing, and says so", async () => {
		const source = sidecarIn(STORAGE_DIR, NOTE);
		const adapter = new SyncDuringMove((n) => [
			source,
			sidecarText(NOTE, [makeComment("a1"), makeComment(`synced-${n}`)]),
		]);
		adapter.deliveries = Infinity;
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));

		const result = await storage.moveTo(TARGET);

		expect(result.leftInSource).toEqual([source]);
		expect(await adapter.exists(source)).toBe(true);
		expect(storage.dir).toBe(TARGET);
	});

	it("resolves when the old folder cannot be removed, and reports it", async () => {
		class StuckFolder extends MemoryAdapter {
			async rmdir(): Promise<void> {
				throw new Error("EBUSY");
			}
		}
		const adapter = new StuckFolder();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));
		await adapter.mkdir(STORAGE_DIR);

		const result = await storage.moveTo(TARGET);

		expect(result.leftInSource).toEqual([`${STORAGE_DIR}/`]);
		expect(storage.dir).toBe(TARGET);
		expect(await storage.getCommentsForFile(NOTE)).toHaveLength(1);
	});

	it.each([["a/b"], ["/a"], ["a/"], ["a\\b"], [""], [".."]])(
		"refuses %j, which is not a single root folder",
		async (target) => {
			const adapter = new MemoryAdapter();
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment("a1"));
			const writes = adapter.writes.length;

			expect(await refusal(storage.moveTo(target))).toBe("not-root-folder");
			expect(adapter.writes).toHaveLength(writes);
			expect(storage.dir).toBe(STORAGE_DIR);
		},
	);

	it.each([[STORAGE_DIR], [".Margin-Comments"]])(
		"refuses %j, the folder it is already in",
		async (target) => {
			const storage = new CommentStorage(new MemoryAdapter());
			expect(await refusal(storage.moveTo(target))).toBe("same-folder");
		},
	);

	it.each([["Comments/notes.md"], ["Comments/sub/x.json"]])(
		"refuses a target holding %s, which is not a comment file",
		async (foreign) => {
			const adapter = new MemoryAdapter({ [foreign]: "mine" });
			const storage = new CommentStorage(adapter);
			await storage.saveComment(makeComment("a1"));
			const before = adapter.snapshot();

			expect(await refusal(storage.moveTo(TARGET))).toBe("foreign-file");
			expect(adapter.snapshot()).toEqual(before);
			expect(storage.dir).toBe(STORAGE_DIR);
		},
	);

	it("merges a sidecar on both sides: newer updatedAt wins either way, one-sided kept", async () => {
		const target = [
			makeComment("c1", NOTE, { updatedAt: 2000, content: "target newer" }),
			makeComment("c2", NOTE, { updatedAt: 1000, content: "target older" }),
			makeComment("t-only"),
		];
		const source = [
			makeComment("c1", NOTE, { updatedAt: 1000, content: "source older" }),
			makeComment("c2", NOTE, { updatedAt: 3000, content: "source newer" }),
			makeComment("s-only"),
		];
		const adapter = new MemoryAdapter({
			[sidecarIn(STORAGE_DIR, NOTE)]: sidecarText(NOTE, source),
			[sidecarIn(TARGET, NOTE)]: sidecarText(NOTE, target),
			// Stale: lists nothing, so the counts must come from a rebuild.
			[`${TARGET}/${INDEX_FILE}`]: JSON.stringify({ version: FORMAT_VERSION, notes: {} }),
		});
		const storage = new CommentStorage(adapter);

		expect(await storage.moveTo(TARGET)).toEqual({
			moved: 0,
			merged: 1,
			keptBoth: 0,
			leftInSource: [],
		});

		expect(await idsIn(adapter, sidecarIn(TARGET, NOTE))).toEqual([
			["c1", "target newer"],
			["c2", "source newer"],
			["t-only", "comment t-only"],
			["s-only", "comment s-only"],
		]);
		expect(await storage.getCommentSummaries()).toEqual([
			{ filePath: NOTE, threads: 4, open: 4 },
		]);
		expect(under(adapter, STORAGE_DIR)).toEqual([]);
	});

	it("merges held sidecars by comment id too", async () => {
		const adapter = new MemoryAdapter({
			[heldIn(STORAGE_DIR, NOTE)]: sidecarText(NOTE, [makeComment("h1"), makeComment("h2")]),
			[heldIn(TARGET, NOTE)]: sidecarText(NOTE, [makeComment("h1"), makeComment("h3")]),
		});
		const storage = new CommentStorage(adapter);

		expect(await storage.moveTo(TARGET)).toEqual({
			moved: 0,
			merged: 1,
			keptBoth: 0,
			leftInSource: [],
		});

		expect((await storage.releaseComments(NOTE))?.map((c) => c.id)).toEqual(["h1", "h3", "h2"]);
		expect(await adapter.exists(STORAGE_DIR)).toBe(false);
	});

	it("keeps a set-aside file beside a different one of the same name", async () => {
		const name = `${hashString("x")}.json.unreadable-5`;
		const adapter = new MemoryAdapter({
			[`${STORAGE_DIR}/${name}`]: "from this device",
			[`${TARGET}/${name}`]: "from another device",
		});
		const storage = new CommentStorage(adapter);

		await storage.moveTo(TARGET);

		expect(adapter.snapshot()).toEqual({
			[`${TARGET}/${name}`]: "from another device",
			[`${TARGET}/${name}-1`]: "from this device",
		});
		expect((await storage.countSetAside()).count).toBe(2);
	});

	it.each([
		["the target", TARGET],
		["the source", STORAGE_DIR],
	])("never rewrites a newer-format sidecar in %s, and keeps the source", async (_, newerIn) => {
		const newer = sidecarText(NOTE, [makeComment("n1"), { future: true }], FORMAT_VERSION + 1);
		const current = sidecarText(NOTE, [makeComment("c1")]);
		const olderIn = newerIn === TARGET ? STORAGE_DIR : TARGET;
		const adapter = new MemoryAdapter({
			[sidecarIn(newerIn, NOTE)]: newer,
			[sidecarIn(olderIn, NOTE)]: current,
			[sidecarIn(STORAGE_DIR, OTHER)]: sidecarText(OTHER, [makeComment("b1", OTHER)]),
		});
		const storage = new CommentStorage(adapter);

		expect(await storage.moveTo(TARGET)).toEqual({
			moved: 1,
			merged: 0,
			keptBoth: 1,
			leftInSource: [sidecarIn(STORAGE_DIR, NOTE)],
		});

		const after = adapter.snapshot();
		expect(after[sidecarIn(newerIn, NOTE)]).toBe(newer);
		expect(after[sidecarIn(olderIn, NOTE)]).toBe(current);
		expect(after[sidecarIn(STORAGE_DIR, OTHER)]).toBeUndefined();
		expect(await adapter.exists(STORAGE_DIR)).toBe(true);
		expect(storage.dir).toBe(TARGET);
	});

	it("copies a newer-format sidecar unchanged when the target has none", async () => {
		const newer = sidecarText(NOTE, [makeComment("n1"), { future: true }], FORMAT_VERSION + 1);
		const adapter = new MemoryAdapter({ [sidecarIn(STORAGE_DIR, NOTE)]: newer });
		const storage = new CommentStorage(adapter);

		expect(await storage.moveTo(TARGET)).toEqual({
			moved: 1,
			merged: 0,
			keptBoth: 0,
			leftInSource: [],
		});
		expect(adapter.snapshot()).toEqual({ [sidecarIn(TARGET, NOTE)]: newer });
	});

	it("leaves the source and the folder alone when a write fails mid-copy, and a re-run completes", async () => {
		const adapter = new FailingWrite();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));
		await storage.saveComment(makeComment("b1", OTHER));
		await storage.saveComment(makeComment("c1", "notes/c.md"));
		const source = under(adapter, STORAGE_DIR).map((path) => [path, adapter.snapshot()[path]]);

		await expect(storage.moveTo(TARGET)).rejects.toThrow("ENOSPC");

		expect(storage.dir).toBe(STORAGE_DIR);
		expect(under(adapter, STORAGE_DIR).map((path) => [path, adapter.snapshot()[path]])).toEqual(
			source,
		);
		expect(await storage.getCommentsForFile(OTHER)).toHaveLength(1);

		expect(await storage.moveTo(TARGET)).toEqual({
			moved: 3,
			merged: 0,
			keptBoth: 0,
			leftInSource: [],
		});
		expect(under(adapter, STORAGE_DIR)).toEqual([]);
		// The index is not among them: it is rebuilt on the next read.
		expect(under(adapter, TARGET)).toHaveLength(3);
	});

	it("refuses to switch when a copy does not read back as written", async () => {
		// Negative case, recorded in the commit: with the read-back comparison made to
		// always pass, this move switched folder and deleted the only good copy.
		const adapter = new CorruptingWrite();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment("a1"));
		const source = adapter.snapshot()[sidecarIn(STORAGE_DIR, NOTE)];

		expect(await refusal(storage.moveTo(TARGET))).toBe("unverified");

		expect(storage.dir).toBe(STORAGE_DIR);
		expect(adapter.snapshot()[sidecarIn(STORAGE_DIR, NOTE)]).toBe(source);
	});

	it("finishes a move cut after the switch when run again from the source", async () => {
		const adapter = new DyingRemove();
		const first = new CommentStorage(adapter);
		await first.saveComment(makeComment("a1"));
		await first.saveComment(makeComment("b1", OTHER));
		await first.saveComment(makeComment("c1", "notes/c.md"));
		adapter.armed = true;

		const cut = await first.moveTo(TARGET);
		expect(first.dir).toBe(TARGET);
		const leftover = under(adapter, STORAGE_DIR);
		expect(leftover.length).toBeGreaterThan(0);
		expect(cut.leftInSource).toEqual(expect.arrayContaining(leftover));
		const target = adapter.snapshot();

		// What Obsidian finds after a restart: the setting still names the source.
		const second = new CommentStorage(adapter);
		await second.moveTo(TARGET);

		expect(under(adapter, STORAGE_DIR)).toEqual([]);
		expect(await adapter.exists(STORAGE_DIR)).toBe(false);
		for (const filePath of [NOTE, OTHER, "notes/c.md"]) {
			expect(adapter.snapshot()[sidecarIn(TARGET, filePath)]).toBe(
				target[sidecarIn(TARGET, filePath)],
			);
		}
	});

	it("drops an unreadable target index and its leftover .tmp, but keeps a newer plugin's index", async () => {
		const newerIndex = JSON.stringify({ version: FORMAT_VERSION + 1, notes: {} });
		const kept = new MemoryAdapter({ [`${TARGET}/${INDEX_FILE}`]: newerIndex });
		await new CommentStorage(kept).moveTo(TARGET);
		expect(kept.snapshot()[`${TARGET}/${INDEX_FILE}`]).toBe(newerIndex);

		const dropped = new MemoryAdapter({
			[`${TARGET}/${INDEX_FILE}`]: "{not json",
			[`${TARGET}/${INDEX_FILE}.tmp`]: "{half",
		});
		await new CommentStorage(dropped).moveTo(TARGET);
		expect(dropped.snapshot()).toEqual({});
	});
});

describe("mergeComments", () => {
	it("is idempotent, so a re-run changes nothing", () => {
		const target = [makeComment("a", NOTE, { updatedAt: 5 }), makeComment("b")];
		const source = [makeComment("a", NOTE, { updatedAt: 9 }), makeComment("c"), "junk"];
		const once = mergeComments(target, source);
		expect(mergeComments(once, source)).toEqual(once);
	});

	it("keeps the target's on a tie, and carries comments without an id untouched", () => {
		const ours = makeComment("a", NOTE, { content: "target" });
		const merged = mergeComments([ours, null], [makeComment("a"), { no: "id" }, null]);
		expect(merged).toEqual([ours, null, { no: "id" }]);
	});
});
