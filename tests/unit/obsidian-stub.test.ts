import { describe, it, expect } from "vitest";
import { normalizePath } from "obsidian";

// The stub stands in for Obsidian's own implementation, so its behaviour has to
// match: a divergence here would hide a real path bug behind a green suite.
describe("normalizePath stub", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizePath("notes\\meeting.md")).toBe("notes/meeting.md");
	});

	it("collapses duplicate slashes", () => {
		expect(normalizePath("notes//sub///a.md")).toBe("notes/sub/a.md");
	});

	it("strips leading and trailing slashes", () => {
		expect(normalizePath("/notes/a.md/")).toBe("notes/a.md");
	});

	it("normalises unicode to NFC", () => {
		expect(normalizePath("reunión.md")).toBe("reunión.md".normalize("NFC"));
	});
});
