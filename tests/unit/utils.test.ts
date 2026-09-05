import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hashString } from "../../src/utils";

describe("hashString", () => {
	it("returns 16 lowercase hex characters", () => {
		expect(hashString("notes/meeting.md")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic across calls", () => {
		expect(hashString("notes/meeting.md")).toBe(hashString("notes/meeting.md"));
	});

	it("distinguishes inputs differing by one character", () => {
		expect(hashString("notes/a.md")).not.toBe(hashString("notes/b.md"));
	});

	it("distinguishes inputs differing only in order", () => {
		expect(hashString("ab")).not.toBe(hashString("ba"));
	});

	it("handles non-ASCII input", () => {
		expect(hashString("notas/reunión.md")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("does not collapse characters onto their low byte", () => {
		// U+0141 and U+0041 share a low byte; a hash folding code units to 8 bits
		// would return the same digest for both.
		expect(hashString("Ł")).not.toBe(hashString("A"));
	});

	it("handles the empty string", () => {
		expect(hashString("")).toMatch(/^[0-9a-f]{16}$/);
	});

	// The plugin must load on mobile, where Node built-ins do not exist: a hash
	// reaching for require('crypto') would break the plugin entirely.
	//
	// Comments are stripped before matching. The implementation explains why it
	// avoids exactly that call, and a plain text search flags the explanation.
	it("does not import Node built-ins", () => {
		const source = readFileSync("src/utils.ts", "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(source).not.toMatch(/\brequire\s*\(/);
		expect(source).not.toMatch(/from\s+["']node:/);
		expect(source).not.toMatch(/from\s+["'](fs|path|crypto|os|buffer)["']/);
	});
});
