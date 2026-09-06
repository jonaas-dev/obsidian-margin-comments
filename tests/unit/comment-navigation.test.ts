import { describe, it, expect } from "vitest";
import { findAdjacentLine } from "../../src/editor/comment-navigation";

describe("findAdjacentLine", () => {
	const lines = [2, 7, 7, 15];

	it("goes to the first commented line after the cursor", () => {
		expect(findAdjacentLine(lines, 3, "next")).toBe(7);
	});

	it("goes to the last commented line before the cursor", () => {
		expect(findAdjacentLine(lines, 10, "previous")).toBe(7);
	});

	it("skips the line the cursor is already on", () => {
		expect(findAdjacentLine(lines, 7, "next")).toBe(15);
		expect(findAdjacentLine(lines, 7, "previous")).toBe(2);
	});

	it("wraps at the end of the note", () => {
		// Without wrapping the last comment is a dead end, and pressing the key
		// again does nothing — which reads as the command being broken.
		expect(findAdjacentLine(lines, 15, "next")).toBe(2);
		expect(findAdjacentLine(lines, 99, "next")).toBe(2);
	});

	it("wraps at the start of the note", () => {
		expect(findAdjacentLine(lines, 2, "previous")).toBe(15);
		expect(findAdjacentLine(lines, 1, "previous")).toBe(15);
	});

	it("takes unsorted input", () => {
		expect(findAdjacentLine([15, 2, 7], 3, "next")).toBe(7);
	});

	it("returns the only commented line, wherever the cursor is", () => {
		expect(findAdjacentLine([4], 4, "next")).toBe(4);
		expect(findAdjacentLine([4], 9, "previous")).toBe(4);
	});

	it("has nowhere to go in a note without anchored comments", () => {
		expect(findAdjacentLine([], 1, "next")).toBeNull();
		expect(findAdjacentLine([], 1, "previous")).toBeNull();
	});
});
