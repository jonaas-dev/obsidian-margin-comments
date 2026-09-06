import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const obsidianPkg = JSON.parse(readFileSync("node_modules/obsidian/package.json", "utf8"));

describe("CodeMirror versions", () => {
	// Obsidian provides these at runtime and pins them exactly. Building against a
	// different version means compiling against an API the editor does not have —
	// and because they are external in the bundle, nothing would catch it until
	// the plugin misbehaves inside Obsidian.
	const peers: Record<string, string> = obsidianPkg.peerDependencies ?? {};

	it("declares every CodeMirror peer Obsidian requires", () => {
		for (const name of Object.keys(peers)) {
			expect(pkg.devDependencies).toHaveProperty(name);
		}
	});

	it("pins them to the exact versions Obsidian ships", () => {
		for (const [name, version] of Object.entries(peers)) {
			expect(pkg.devDependencies[name]).toBe(version);
		}
	});
});
