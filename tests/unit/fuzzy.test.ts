import { describe, it, expect } from "vitest";
import { boundedLevenshtein } from "../../src/fuzzy";

describe("boundedLevenshtein", () => {
	it("is zero for identical strings", () => {
		expect(boundedLevenshtein("hello", "hello", 3)).toBe(0);
	});

	it("counts substitutions, insertions and deletions", () => {
		expect(boundedLevenshtein("kitten", "sitting", 5)).toBe(3);
		expect(boundedLevenshtein("flaw", "lawn", 5)).toBe(2);
		expect(boundedLevenshtein("abc", "abcd", 5)).toBe(1);
		expect(boundedLevenshtein("abcd", "abc", 5)).toBe(1);
	});

	it("is symmetric", () => {
		expect(boundedLevenshtein("sitting", "kitten", 5)).toBe(3);
	});

	it("handles empty strings", () => {
		expect(boundedLevenshtein("", "", 2)).toBe(0);
		expect(boundedLevenshtein("", "ab", 2)).toBe(2);
		expect(boundedLevenshtein("ab", "", 2)).toBe(2);
	});

	it("gives up rather than computing a distance beyond the bound", () => {
		// The caller only ever asks "is this within tolerance?", so anything past
		// the bound is reported as max + 1 without finishing the table.
		expect(boundedLevenshtein("kitten", "sitting", 2)).toBe(3);
		expect(boundedLevenshtein("kitten", "sitting", 1)).toBe(2);
		expect(boundedLevenshtein("abcdef", "uvwxyz", 2)).toBe(3);
	});

	it("rejects on length difference alone, without filling a table", () => {
		expect(boundedLevenshtein("a", "abcdefghij", 3)).toBe(4);
	});

	it("still answers exactly at the bound", () => {
		expect(boundedLevenshtein("kitten", "sitting", 3)).toBe(3);
	});

	it("stays fast on the long strings a bad candidate produces", () => {
		// A banded table is O(n·k), not O(n·m): the guard against a comment on a
		// long paragraph turning re-anchoring quadratic.
		const a = "the quick brown fox jumps over the lazy dog. ".repeat(40);
		const b = "a completely different sentence entirely, again. ".repeat(40);
		const start = performance.now();
		expect(boundedLevenshtein(a, b, 5)).toBe(6);
		expect(performance.now() - start).toBeLessThan(50);
	});
});
