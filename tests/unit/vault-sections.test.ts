import { describe, it, expect } from "vitest";
import {
	buildSections,
	countSections,
	filterSections,
	vaultEmptyStateMessage,
} from "../../src/ui/vault-sections";
import { THREAD_FILTERS } from "../../src/types";
import type { CommentSummary } from "../../src/storage";

const summary = (filePath: string, threads: number, open: number): CommentSummary => ({
	filePath,
	threads,
	open,
});

describe("buildSections", () => {
	const summaries = [summary("zeta.md", 1, 1), summary("alpha.md", 2, 0), summary("gone.md", 3, 3)];
	const exists = (path: string) => path !== "gone.md";

	it("sorts by path so the list is scannable", () => {
		expect(buildSections(summaries, exists).map((s) => s.filePath)).toEqual([
			"alpha.md",
			"zeta.md",
			"gone.md",
		]);
	});

	it("marks a note that is no longer in the vault", () => {
		// Renaming a note strands its sidecar until rename tracking lands. Hiding
		// those comments would look like data loss; naming them does not.
		const sections = buildSections(summaries, exists);
		expect(sections.map((s) => s.missing)).toEqual([false, false, true]);
	});

	it("puts missing notes last, whatever their path", () => {
		const sections = buildSections([summary("aaa.md", 1, 1), summary("zzz.md", 1, 1)], () => false);
		expect(sections.every((s) => s.missing)).toBe(true);
	});

	it("carries the counts through untouched", () => {
		const [alpha] = buildSections([summary("alpha.md", 2, 1)], exists);
		expect(alpha).toEqual({ filePath: "alpha.md", threads: 2, open: 1, missing: false });
	});
});

describe("filterSections", () => {
	const sections = buildSections(
		[summary("all-open.md", 2, 2), summary("all-done.md", 3, 0), summary("mixed.md", 4, 1)],
		() => true,
	);

	it("keeps every note under 'all'", () => {
		expect(filterSections(sections, "all")).toHaveLength(3);
	});

	it("drops notes with nothing open under 'open'", () => {
		expect(filterSections(sections, "open").map((s) => s.filePath)).toEqual([
			"all-open.md",
			"mixed.md",
		]);
	});

	it("drops notes with nothing resolved under 'resolved'", () => {
		expect(filterSections(sections, "resolved").map((s) => s.filePath)).toEqual([
			"all-done.md",
			"mixed.md",
		]);
	});
});

describe("countSections", () => {
	it("totals threads across the vault, per bucket", () => {
		const sections = buildSections(
			[summary("a.md", 2, 2), summary("b.md", 3, 0), summary("c.md", 4, 1)],
			() => true,
		);
		expect(countSections(sections)).toEqual({ all: 9, open: 3, resolved: 6 });
	});

	it("is all zeroes for an empty vault", () => {
		expect(countSections([])).toEqual({ all: 0, open: 0, resolved: 0 });
	});
});

describe("vaultEmptyStateMessage", () => {
	it("talks about the vault, not the open note", () => {
		for (const filter of THREAD_FILTERS) {
			expect(vaultEmptyStateMessage(filter)).toContain("vault");
		}
	});

	it("gives each filter its own message", () => {
		const messages = THREAD_FILTERS.map(vaultEmptyStateMessage);
		expect(new Set(messages).size).toBe(THREAD_FILTERS.length);
	});
});
