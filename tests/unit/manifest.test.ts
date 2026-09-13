import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

// These mirror the Obsidian community directory submission requirements. Catching
// a violation here is cheaper than catching it in review weeks after submitting.
describe("manifest.json", () => {
	it("declares the expected plugin id", () => {
		expect(manifest.id).toBe("margin-comments");
	});

	it("keeps 'obsidian' out of the id, which the directory rejects", () => {
		expect(manifest.id.toLowerCase()).not.toContain("obsidian");
	});

	it("keeps the version in sync with package.json", () => {
		expect(manifest.version).toBe(pkg.version);
	});

	it("uses semantic versioning", () => {
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("records the version in versions.json", () => {
		expect(versions[manifest.version]).toBe(manifest.minAppVersion);
	});

	it("supports mobile", () => {
		expect(manifest.isDesktopOnly).toBe(false);
	});

	describe("description", () => {
		it("stays under the 250 character limit", () => {
			expect(manifest.description.length).toBeLessThanOrEqual(250);
		});

		it("starts with an action verb, not 'This is a plugin'", () => {
			expect(manifest.description).toMatch(/^[A-Z][a-z]+ /);
			expect(manifest.description.toLowerCase()).not.toContain("this is a plugin");
		});

		it("contains no emoji", () => {
			expect(manifest.description).not.toMatch(/\p{Extended_Pictographic}/u);
		});

		it("ends with a full stop", () => {
			expect(manifest.description.endsWith(".")).toBe(true);
		});
	});
});
