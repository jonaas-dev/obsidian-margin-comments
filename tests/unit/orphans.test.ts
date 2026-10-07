import { describe, it, expect } from "vitest";
import { OrphanNotice, orphanCount, orphanExplanation } from "../../src/ui/orphans";
import { buildThreads, type Thread } from "../../src/threads";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = ["alpha line", "beta line", "gamma line"].join("\n");

function comment(id: string, text: string, source = doc): Comment {
	const from = source.indexOf(text);
	return {
		id,
		filePath: "note.md",
		anchor: createAnchor(source, from, from + text.length),
		content: `body of ${id}`,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

function threadFor(text: string, against: string): Thread {
	return buildThreads(against, [comment("c", text)])[0];
}

describe("orphanCount", () => {
	it("counts only the threads with no anchor", () => {
		const threads = buildThreads(doc, [
			comment("a", "alpha"),
			comment("lost", "not in the note"),
		]);
		expect(orphanCount(threads)).toBe(1);
	});

	it("is zero when everything is anchored", () => {
		expect(orphanCount(buildThreads(doc, [comment("a", "alpha")]))).toBe(0);
	});
});

describe("orphanExplanation", () => {
	it("names the note, so a card in the vault view says where it came from", () => {
		const thread = threadFor("alpha line", "nothing familiar");
		expect(orphanExplanation(thread, "notes/deep/journal.md")).toContain("journal");
	});

	it("drops the folder and the extension rather than printing a path", () => {
		const thread = threadFor("alpha line", "nothing familiar");
		expect(orphanExplanation(thread, "notes/deep/journal.md")).not.toContain("notes/deep");
	});

	it("gives the line the anchor was written on", () => {
		const thread = threadFor("gamma line", "nothing familiar");
		expect(thread.root.anchor.lineHint).toBe(3);
		expect(orphanExplanation(thread, "note.md")).toContain("line 3");
	});

	it("says restoring the text brings the comment back, because it does", () => {
		const thread = threadFor("alpha line", "nothing familiar");
		expect(orphanExplanation(thread, "note.md")).toContain("restoring the text");
	});
});

describe("OrphanNotice", () => {
	it("announces the first orphans it is shown", () => {
		expect(new OrphanNotice().take(3)).toContain("3 comments");
	});

	it("uses the singular for one", () => {
		expect(new OrphanNotice().take(1)).toContain("1 comment lost its anchor");
	});

	it("stays silent when nothing is orphaned", () => {
		expect(new OrphanNotice().take(0)).toBeNull();
	});

	it("says nothing the second time, however many notes are visited", () => {
		// The panel rebuilds its threads on every note switch, filter click and
		// keystroke; without this the same news arrives on each one.
		const notice = new OrphanNotice();
		expect(notice.take(2)).not.toBeNull();
		expect(notice.take(2)).toBeNull();
		expect(notice.take(7)).toBeNull();
	});

	it("reports itself spent, so the search can be skipped once it is", () => {
		// The one caller outside the panel runs a fuzzy pass to produce the count.
		// Without this it keeps paying for a number it can no longer report.
		const notice = new OrphanNotice();
		expect(notice.spent).toBe(false);
		notice.take(0);
		expect(notice.spent).toBe(false);
		notice.take(2);
		expect(notice.spent).toBe(true);
	});

	it("is not armed by a note with no orphans", () => {
		// A quiet note must not spend the one announcement the session gets.
		const notice = new OrphanNotice();
		expect(notice.take(0)).toBeNull();
		expect(notice.take(4)).toContain("4 comments");
	});
});

describe("recovering an orphan", () => {
	it("re-anchors as soon as the text comes back, with the anchor untouched", () => {
		const original = comment("a", "beta line");
		const stored = structuredClone(original.anchor);

		const [lost] = buildThreads("nothing familiar here", [original]);
		expect(lost.orphaned).toBe(true);

		const [found] = buildThreads(doc, [original]);
		expect(found.orphaned).toBe(false);
		expect(found.line).toBe(2);
		// Nothing rewrites the anchor while the text is missing, which is the only
		// reason the comment can find its way home.
		expect(original.anchor).toEqual(stored);
	});
});

describe("OrphanNotice with the panel on screen (#143)", () => {
	it("does not tell the reader to open a panel they are already looking at", () => {
		const message = new OrphanNotice().take(1, true);
		expect(message).toContain("1 comment lost its anchor");
		expect(message).not.toContain("Open the comments panel");
	});

	it("still points to the panel when it is not on screen", () => {
		expect(new OrphanNotice().take(2, false)).toContain(
			"Open the comments panel to see which.",
		);
	});
});
