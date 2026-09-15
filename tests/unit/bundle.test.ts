import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import builtins from "builtin-modules";

/**
 * The built plugin. `main.js` is generated and not in the repository, so this
 * file needs `npm run build` to have run — CI builds before it tests for that
 * reason. Failing loudly beats skipping: a bundle audit that quietly does
 * nothing when the bundle is missing is worse than no audit.
 */
function readBundle(): string {
	try {
		return readFileSync("main.js", "utf8");
	} catch {
		throw new Error("main.js is missing — run `npm run build` before `npm test`.");
	}
}

const bundle = readBundle();

/**
 * Node built-ins in main.js are fatal on mobile, not merely wasteful.
 *
 * Obsidian on desktop runs in Electron and would resolve `require("fs")` quite
 * happily; on iOS and Android there is no Node at all, so the plugin fails to
 * load — not the feature that reached for it, the whole plugin. The build marks
 * them external, which means an accidental import does not fail the build: it
 * leaves a bare `require` in the output for the runtime to trip over.
 */
describe("the shipped bundle", () => {
	it("is the built output, not a stale or empty file", () => {
		// Without this, a missing main.js would report a perfectly clean bundle.
		expect(bundle.length).toBeGreaterThan(10000);
		expect(bundle).toContain("inline-comment");
	});

	it("requires nothing Node-only, which mobile has no answer for", () => {
		const reached = (builtins as string[])
			.flatMap((name) => [name, `node:${name}`])
			.filter((name) => {
				const pattern = new RegExp(`require\\(\\s*["'\`]${name}["'\`]\\s*\\)`);
				return pattern.test(bundle);
			});
		expect(reached).toEqual([]);
	});

	it("holds no regex lookbehind, which stops the whole bundle loading on older iOS", () => {
		// WebKit only parses lookbehind from iOS 16.4, and Obsidian's iOS app runs on
		// older releases. A regex literal is parsed with the script that holds it, so
		// one lookbehind anywhere is not a broken feature there but a plugin that
		// never loads (#248). Chromium has parsed it since 2018, so neither desktop
		// nor the Android emulator would ever show the failure.
		const lookbehinds = bundle.match(/\(\?<[=!][^)]{0,30}/g) ?? [];
		expect(lookbehinds).toEqual([]);
	});

	it("requires nothing but what Obsidian provides at runtime", () => {
		// The same check from the other side: whatever else the bundle reaches for
		// has to be something the editor hands it. Anything new here is either a
		// dependency that should have been bundled or a built-in under an alias.
		const required = [...bundle.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(
			(match) => match[1],
		);
		const allowed = /^(obsidian|electron|@codemirror\/|@lezer\/)/;
		expect([...new Set(required)].filter((name) => !allowed.test(name))).toEqual([]);
	});
});
