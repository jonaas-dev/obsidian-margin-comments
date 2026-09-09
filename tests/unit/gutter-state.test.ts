import { describe, it, expect } from "vitest";
import {
	countBadgeText,
	isNearLeftEdge,
	linesWithOpenComments,
	markerLabel,
	shouldShowMarker,
} from "../../src/editor/gutter-state";
import { createAnchor } from "../../src/anchor";
import type { Comment } from "../../src/types";

const doc = ["alpha line", "beta line", "gamma line"].join("\n");

function commentOn(text: string, overrides: Partial<Comment> = {}): Comment {
	const from = doc.indexOf(text);
	return {
		id: `c-${text}`,
		filePath: "note.md",
		anchor: createAnchor(doc, from, from + text.length),
		content: "a comment",
		author: "someone",
		createdAt: 1,
		updatedAt: 1,
		resolved: false,
		parentId: null,
		...overrides,
	};
}

describe("linesWithOpenComments", () => {
	it("marks the line an anchored comment sits on", () => {
		expect(linesWithOpenComments(doc, [commentOn("beta")])).toEqual(new Set([2]));
	});

	it("ignores resolved comments", () => {
		expect(linesWithOpenComments(doc, [commentOn("beta", { resolved: true })])).toEqual(new Set());
	});

	it("ignores replies, which share their root's line", () => {
		// A reply has no independent anchor, so counting it would be double work
		// for the same line and would keep a line marked after its root resolves.
		const root = commentOn("beta");
		const reply = commentOn("beta", { id: "r1", parentId: root.id });
		expect(linesWithOpenComments(doc, [root, reply])).toEqual(new Set([2]));
	});

	it("marks several lines at once", () => {
		expect(linesWithOpenComments(doc, [commentOn("alpha"), commentOn("gamma")])).toEqual(
			new Set([1, 3]),
		);
	});

	it("skips a comment whose text is gone", () => {
		const orphan = commentOn("beta");
		expect(linesWithOpenComments("nothing familiar here", [orphan])).toEqual(new Set());
	});

	it("follows the text when the note is reordered", () => {
		const comment = commentOn("beta");
		const reordered = ["gamma line", "alpha line", "beta line"].join("\n");
		expect(linesWithOpenComments(reordered, [comment])).toEqual(new Set([3]));
	});
});

describe("shouldShowMarker", () => {
	const commented = new Set([2]);
	const on = { commented, touch: false, cursorLine: null, enabled: true };

	it("shows on a line that has an open comment", () => {
		expect(shouldShowMarker(2, { ...on, hoveredLine: null })).toBe(true);
	});

	it("shows on the hovered line even with no comment", () => {
		expect(shouldShowMarker(3, { ...on, hoveredLine: 3 })).toBe(true);
	});

	it("hides on an unrelated line", () => {
		expect(shouldShowMarker(1, { ...on, hoveredLine: 3 })).toBe(false);
	});

	it("follows the caret on touch, where there is no hover to follow", () => {
		expect(shouldShowMarker(3, { ...on, hoveredLine: null, touch: true, cursorLine: 3 })).toBe(
			true,
		);
	});

	it("does not mark every line on touch", () => {
		// It used to. A speech bubble beside every line of the note stops reading
		// as "something is here" and becomes wallpaper.
		expect(shouldShowMarker(1, { ...on, hoveredLine: null, touch: true, cursorLine: 3 })).toBe(
			false,
		);
	});

	it("keeps marking commented lines on touch wherever the caret is", () => {
		expect(shouldShowMarker(2, { ...on, hoveredLine: null, touch: true, cursorLine: 3 })).toBe(
			true,
		);
	});

	it("ignores hover on touch, so a stale pointer cannot leave a marker behind", () => {
		// A tablet with a trackpad reports both; the caret is the deliberate act.
		expect(shouldShowMarker(4, { ...on, hoveredLine: 4, touch: true, cursorLine: 3 })).toBe(
			false,
		);
	});

	it("hides a commented line when the gutter is switched off", () => {
		expect(shouldShowMarker(2, { ...on, hoveredLine: null, enabled: false })).toBe(false);
	});

	it("hides the hovered line too, which is the affordance itself", () => {
		// Hiding only the commented lines would leave the "add a comment" marker
		// following the pointer, so the setting would look broken.
		expect(shouldShowMarker(3, { ...on, hoveredLine: 3, enabled: false })).toBe(false);
	});

	it("stays off on touch too, caret line included", () => {
		expect(
			shouldShowMarker(3, {
				...on,
				hoveredLine: null,
				touch: true,
				cursorLine: 3,
				enabled: false,
			}),
		).toBe(false);
	});
});

describe("isNearLeftEdge", () => {
	const rect = { left: 100, width: 40 };

	it("is true within the threshold of the left edge", () => {
		expect(isNearLeftEdge(110, rect, 20)).toBe(true);
	});

	it("is false beyond the threshold", () => {
		expect(isNearLeftEdge(130, rect, 20)).toBe(false);
	});

	it("is false to the left of the element", () => {
		expect(isNearLeftEdge(80, rect, 20)).toBe(false);
	});
});

describe("countBadgeText", () => {
	it("says nothing for a line carrying one thread", () => {
		// A badge reading "1" tells the reader nothing the icon does not.
		expect(countBadgeText(0)).toBeNull();
		expect(countBadgeText(1)).toBeNull();
	});

	it("counts from two up", () => {
		expect(countBadgeText(2)).toBe("2");
		expect(countBadgeText(9)).toBe("9");
	});

	it("caps at two glyphs, which is what the gutter column holds", () => {
		// Measured: Obsidian pins the gutter to ~17px, and a third glyph puts the
		// badge past its right edge.
		expect(countBadgeText(10)).toBe("9+");
		expect(countBadgeText(148)).toBe("9+");
	});
});

describe("markerLabel", () => {
	it("offers the action when the line has no comment", () => {
		expect(markerLabel(0)).toBe("Add a comment");
	});

	it("gives a screen reader the exact number, uncapped and never a bare digit", () => {
		// The badge is capped and silent at one; the label is neither, because it
		// is the only place a screen reader hears the count at all.
		expect(markerLabel(1)).toBe("1 comment on this line");
		expect(markerLabel(3)).toBe("3 comments on this line");
		expect(markerLabel(148)).toBe("148 comments on this line");
	});
});
