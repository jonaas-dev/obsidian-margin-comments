import { describe, it, expect } from "vitest";
import {
	SORT_ORDERS,
	lastActivity,
	sortLabel,
	sortThreads,
	toSortOrder,
} from "../../src/ui/panel-sort";
import type { Thread } from "../../src/threads";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = "alpha line\nbeta line";

function comment(id: string, overrides: Partial<Comment> = {}): Comment {
	return {
		id,
		filePath: "note.md",
		anchor: createAnchor(doc, 0, 5),
		content: `body of ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

interface ThreadSpec {
	position: number | null;
	createdAt?: number;
	updatedAt?: number;
	replies?: number[];
}

function thread(id: string, spec: ThreadSpec): Thread {
	const { position, createdAt = 1000, updatedAt = createdAt, replies = [] } = spec;
	return {
		root: comment(id, { createdAt, updatedAt }),
		replies: replies.map((at, i) =>
			comment(`${id}-r${i}`, { parentId: id, createdAt: at, updatedAt: at }),
		),
		line: position === null ? null : 1,
		position,
		end: position === null ? null : position + 5,
		orphaned: position === null,
	};
}

const ids = (threads: Thread[]) => threads.map((t) => t.root.id);

describe("sortThreads", () => {
	it("orders by anchor offset under 'position'", () => {
		const threads = [
			thread("third", { position: 30 }),
			thread("first", { position: 0 }),
			thread("second", { position: 12 }),
		];
		expect(ids(sortThreads(threads, "position"))).toEqual(["first", "second", "third"]);
	});

	it("puts the newest first under 'date'", () => {
		const threads = [
			thread("old", { position: 0, createdAt: 100 }),
			thread("new", { position: 30, createdAt: 900 }),
			thread("mid", { position: 12, createdAt: 500 }),
		];
		expect(ids(sortThreads(threads, "date"))).toEqual(["new", "mid", "old"]);
	});

	it("ranks a thread by its most recent reply under 'lastActivity'", () => {
		// The root is the oldest thing in the vault, but someone replied to it a
		// moment ago: activity is about the thread, not its opening comment.
		const threads = [
			thread("quiet", { position: 0, createdAt: 800, updatedAt: 800 }),
			thread("revived", { position: 30, createdAt: 100, replies: [900] }),
		];
		expect(ids(sortThreads(threads, "lastActivity"))).toEqual(["revived", "quiet"]);
	});

	it("sorts orphans last in every mode", () => {
		const threads = [
			thread("lost", { position: null, createdAt: 9000, updatedAt: 9000 }),
			thread("anchored", { position: 30, createdAt: 100 }),
		];
		for (const order of SORT_ORDERS) {
			// A lost anchor has no position to sort by, and it is the newest thread
			// here, so date and activity would otherwise float it to the top.
			expect(ids(sortThreads(threads, order))).toEqual(["anchored", "lost"]);
		}
	});

	it("keeps orphans in their incoming order among themselves", () => {
		const threads = [thread("b", { position: null }), thread("a", { position: null })];
		expect(ids(sortThreads(threads, "position"))).toEqual(["b", "a"]);
	});

	it("is stable for ties, in every mode", () => {
		const tied = [
			thread("x", { position: 5, createdAt: 500 }),
			thread("y", { position: 5, createdAt: 500 }),
			thread("z", { position: 5, createdAt: 500 }),
		];
		for (const order of SORT_ORDERS) {
			expect(ids(sortThreads(tied, order))).toEqual(["x", "y", "z"]);
		}
	});

	it("does not mutate the array it was given", () => {
		const threads = [thread("b", { position: 30 }), thread("a", { position: 0 })];
		sortThreads(threads, "position");
		expect(ids(threads)).toEqual(["b", "a"]);
	});
});

describe("lastActivity", () => {
	it("is the root's own timestamp when nobody replied", () => {
		expect(lastActivity(thread("a", { position: 0, updatedAt: 700 }))).toBe(700);
	});

	it("takes the maximum across the thread, replies included", () => {
		expect(lastActivity(thread("a", { position: 0, updatedAt: 700, replies: [200, 950] }))).toBe(
			950,
		);
	});

	it("ignores replies older than the root", () => {
		expect(lastActivity(thread("a", { position: 0, updatedAt: 700, replies: [200] }))).toBe(700);
	});
});

describe("sortLabel", () => {
	it("labels every order", () => {
		expect(SORT_ORDERS.map(sortLabel)).toEqual(["Document order", "Date created", "Last activity"]);
	});
});

describe("toSortOrder", () => {
	it("accepts the known orders", () => {
		for (const order of SORT_ORDERS) expect(toSortOrder(order)).toBe(order);
	});

	it("falls back to document order for anything else", () => {
		expect(toSortOrder("author")).toBe("position");
		expect(toSortOrder(undefined)).toBe("position");
		expect(toSortOrder(null)).toBe("position");
		expect(toSortOrder(7)).toBe("position");
	});
});
