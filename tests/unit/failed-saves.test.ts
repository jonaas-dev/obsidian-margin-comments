import { describe, it, expect, beforeEach } from "vitest";
// Through the file, not the "obsidian" alias: tsc resolves that to the real
// types package, which has no such export. vitest aliases both to this module.
import { clearNotices, noticeMessages } from "../helpers/obsidian-stub";
import {
	CommentNotFoundError,
	CommentStorage,
	FORMAT_VERSION,
	NewerFormatError,
	STORAGE_DIR,
	describeFailedSave,
} from "../../src/storage";
import { describeResolveAllFailures } from "../../src/ui/comment-actions";
import { describeStrandedComments } from "../../src/note-moves";
import { NoteEvents } from "../../src/vault-events";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";
import { MemoryAdapter } from "../helpers/memory-adapter";

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
		content: "a comment",
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

describe("describeFailedSave", () => {
	it("passes through the cause when the format is newer", () => {
		const error = new NewerFormatError("notes/meeting.md");
		expect(describeFailedSave("notes/meeting.md", error)).toBe(error.message);
	});

	it("passes through the cause when the comment is gone", () => {
		const error = new CommentNotFoundError("notes/meeting.md", "c1");
		expect(describeFailedSave("notes/meeting.md", error)).toBe(error.message);
	});

	it("still says the change was not saved for a cause it cannot name", () => {
		// A full disk, a permissions error, a file a sync client holds. The reader
		// cannot tell a failed write from a successful one without being told.
		const message = describeFailedSave("notes/meeting.md", new Error("EACCES"));
		expect(message).toContain("meeting");
		expect(message).toContain("could not be saved");
	});

	it("names the note rather than its path", () => {
		expect(describeFailedSave("deep/folder/meeting.md", new Error("x"))).not.toContain("deep/");
	});
});

describe("describeResolveAllFailures", () => {
	it("says how many of how many, and that the rest went through", () => {
		expect(describeResolveAllFailures(2, 5)).toBe(
			"2 of 5 threads could not be resolved. The rest were.",
		);
	});

	it("reads as one thread when only one failed", () => {
		expect(describeResolveAllFailures(1, 3)).toContain("1 of 3 thread ");
	});
});

describe("describeStrandedComments", () => {
	it("names the note when only one stayed behind", () => {
		expect(describeStrandedComments(["notes/meeting.md"])).toContain("meeting.md");
	});

	it("counts them when more than one did", () => {
		expect(describeStrandedComments(["a/one.md", "b/two.md"])).toContain("2 notes");
	});
});

describe("a rename a note cannot follow", () => {
	beforeEach(() => clearNotices());

	/** A store where `movable` has comments and `stuck` has a sidecar this version may not write. */
	async function storageWithOneStuckNote(): Promise<{
		storage: CommentStorage;
		movable: string;
		stuck: string;
	}> {
		const movable = "notes/movable.md";
		const stuck = "notes/stuck.md";
		const adapter = new MemoryAdapter();
		const storage = new CommentStorage(adapter);
		await storage.saveComment(makeComment(movable, "c1"));
		await storage.saveComment(makeComment(stuck, "c2"));
		// Rewritten underneath, as a newer plugin version would leave it: every
		// write to this note is refused from here on.
		await adapter.write(
			sidecarFor(stuck),
			JSON.stringify({ version: FORMAT_VERSION + 1, comments: [makeComment(stuck, "c2")] }),
		);
		return { storage, movable, stuck };
	}

	it("moves the notes it can and reports the one it cannot", async () => {
		const { storage, movable, stuck } = await storageWithOneStuckNote();
		const events = new NoteEvents({
			storage,
			orphanedBehavior: () => "keep",
			refresh: () => Promise.resolve(),
			readNote: () => Promise.resolve(null),
			fuzzyThreshold: () => 0.3,
		});

		await events.followRename("notes", "archive");

		// The movable note went, which a handler that gave up on the first
		// rejection would not have managed.
		expect(await storage.getCommentsForFile("archive/movable.md")).toHaveLength(1);
		expect(await storage.getCommentsForFile(movable)).toHaveLength(0);
		// And the one that could not go is named rather than left a mystery.
		expect(await storage.getCommentsForFile(stuck)).toHaveLength(1);
		expect(noticeMessages.join(" ")).toContain("stuck.md");
	});
})
