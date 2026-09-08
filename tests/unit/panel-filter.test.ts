import { describe, it, expect } from "vitest";
import {
	THREAD_FILTERS,
	countThreads,
	emptyStateMessage,
	filterThreads,
	filterLabel,
	toThreadFilter,
} from "../../src/ui/panel-filter";
import type { Thread } from "../../src/ui/threads";
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

function thread(id: string, resolved: boolean, replies: Comment[] = []): Thread {
	return {
		root: comment(id, { resolved }),
		replies,
		line: 1,
		position: 0,
		end: 5,
		orphaned: false,
	};
}

describe("filterThreads", () => {
	const threads = [thread("open-1", false), thread("done", true), thread("open-2", false)];

	it("keeps every thread under 'all'", () => {
		expect(filterThreads(threads, "all").map((t) => t.root.id)).toEqual([
			"open-1",
			"done",
			"open-2",
		]);
	});

	it("keeps only unresolved threads under 'open'", () => {
		expect(filterThreads(threads, "open").map((t) => t.root.id)).toEqual(["open-1", "open-2"]);
	});

	it("keeps only resolved threads under 'resolved'", () => {
		expect(filterThreads(threads, "resolved").map((t) => t.root.id)).toEqual(["done"]);
	});

	it("preserves the incoming order", () => {
		const ordered = [thread("c", false), thread("a", false), thread("b", false)];
		expect(filterThreads(ordered, "open").map((t) => t.root.id)).toEqual(["c", "a", "b"]);
	});

	it("hides or shows a thread as a unit, replies included", () => {
		// Replies carry no resolved state of their own; a resolved root takes its
		// whole thread out of the open list, replies and all.
		const withReplies = thread("done", true, [comment("r1", { parentId: "done" })]);
		expect(filterThreads([withReplies], "open")).toEqual([]);
		expect(filterThreads([withReplies], "resolved")[0].replies).toHaveLength(1);
	});
});

describe("countThreads", () => {
	it("counts each bucket, with 'all' as the total", () => {
		const counts = countThreads([thread("a", false), thread("b", true), thread("c", true)]);
		expect(counts).toEqual({ all: 3, open: 1, resolved: 2 });
	});

	it("reports zeroes for an empty list", () => {
		expect(countThreads([])).toEqual({ all: 0, open: 0, resolved: 0 });
	});

	it("matches what filterThreads renders, for every filter", () => {
		const threads = [thread("a", false), thread("b", true), thread("c", false)];
		const counts = countThreads(threads);
		for (const filter of THREAD_FILTERS) {
			expect(counts[filter]).toBe(filterThreads(threads, filter).length);
		}
	});
});

describe("emptyStateMessage", () => {
	it("gives each filter its own message, so empty never reads as broken", () => {
		const messages = THREAD_FILTERS.map((filter) => emptyStateMessage(filter));
		expect(new Set(messages).size).toBe(THREAD_FILTERS.length);
		for (const message of messages) expect(message.length).toBeGreaterThan(0);
	});
});

describe("filterLabel", () => {
	it("labels every filter", () => {
		expect(THREAD_FILTERS.map(filterLabel)).toEqual(["All", "Open", "Resolved"]);
	});
});

describe("toThreadFilter", () => {
	it("accepts the known filters", () => {
		for (const filter of THREAD_FILTERS) expect(toThreadFilter(filter)).toBe(filter);
	});

	it("falls back to 'all' for anything else", () => {
		// Persisted state from a future version, or a hand-edited data.json.
		expect(toThreadFilter("unread")).toBe("all");
		expect(toThreadFilter(undefined)).toBe("all");
		expect(toThreadFilter(null)).toBe("all");
		expect(toThreadFilter(3)).toBe("all");
	});
});
