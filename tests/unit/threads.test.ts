import { describe, it, expect } from "vitest";
import { buildThreads, formatRelativeTime } from "../../src/ui/threads";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = ["alpha line", "beta line", "gamma line"].join("\n");

function make(id: string, text: string, overrides: Partial<Comment> = {}): Comment {
	const from = doc.indexOf(text);
	return {
		id,
		filePath: "note.md",
		anchor: createAnchor(doc, from, from + text.length),
		content: `body of ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

describe("buildThreads", () => {
	it("returns one thread per root comment", () => {
		const threads = buildThreads(doc, [make("a", "alpha"), make("b", "beta")]);
		expect(threads.map((t) => t.root.id)).toEqual(["a", "b"]);
	});

	it("nests replies under their root", () => {
		const [thread] = buildThreads(doc, [
			make("a", "alpha"),
			make("r1", "alpha", { parentId: "a" }),
			make("r2", "alpha", { parentId: "a" }),
		]);
		expect(thread.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
	});

	it("orders replies oldest first", () => {
		const [thread] = buildThreads(doc, [
			make("a", "alpha"),
			make("late", "alpha", { parentId: "a", createdAt: 3000 }),
			make("early", "alpha", { parentId: "a", createdAt: 2000 }),
		]);
		expect(thread.replies.map((r) => r.id)).toEqual(["early", "late"]);
	});

	it("keeps a reply whose root is missing rather than losing it", () => {
		// A root can go missing through a partial sync. Dropping the reply would
		// destroy content the user wrote; showing it detached is recoverable.
		const threads = buildThreads(doc, [make("orphanReply", "alpha", { parentId: "gone" })]);
		expect(threads).toHaveLength(1);
		expect(threads[0].root.id).toBe("orphanReply");
	});

	it("orders threads by position in the document", () => {
		const threads = buildThreads(doc, [make("g", "gamma"), make("a", "alpha"), make("b", "beta")]);
		expect(threads.map((t) => t.root.id)).toEqual(["a", "b", "g"]);
	});

	it("puts threads whose anchor is lost at the end", () => {
		const threads = buildThreads(doc, [make("lost", "nowhere in doc"), make("a", "alpha")]);
		expect(threads.map((t) => t.root.id)).toEqual(["a", "lost"]);
		expect(threads.find((t) => t.root.id === "lost")?.orphaned).toBe(true);
	});

	it("reports the line each thread is anchored to", () => {
		const [thread] = buildThreads(doc, [make("b", "beta")]);
		expect(thread.line).toBe(2);
	});

	it("counts replies on the thread", () => {
		const [thread] = buildThreads(doc, [
			make("a", "alpha"),
			make("r1", "alpha", { parentId: "a" }),
		]);
		expect(thread.replies).toHaveLength(1);
	});
});

describe("formatRelativeTime", () => {
	const now = new Date("2026-09-06T12:00:00Z").getTime();

	it("says just now for the last minute", () => {
		expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
	});

	it("counts whole minutes", () => {
		expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
	});

	it("uses the singular for one", () => {
		expect(formatRelativeTime(now - 60_000, now)).toBe("1 minute ago");
	});

	it("counts hours", () => {
		expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
	});

	it("counts days", () => {
		expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
	});

	it("falls back to a date beyond a month", () => {
		expect(formatRelativeTime(now - 60 * 86_400_000, now)).toMatch(/\d{4}/);
	});
});
