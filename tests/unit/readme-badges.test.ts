import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The README badges are static images, so they repeat facts that live elsewhere and
// nothing else would notice when those facts change (#255).
const readme = readFileSync("README.md", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/** The `src` of the badge whose `alt` matches, decoded so it reads as the label does. */
function badge(alt: RegExp): { alt: string; src: string } {
	const match = [
		...readme.matchAll(/<img alt="([^"]+)" src="(https:\/\/img\.shields\.io\/[^"]+)">/g),
	].find(([, text]) => alt.test(text));
	if (!match) throw new Error(`no badge with alt matching ${alt}`);
	return { alt: match[1], src: decodeURIComponent(match[2]) };
}

describe("README badges", () => {
	it("says what the coverage badge measures, not just a number", () => {
		// "coverage 98%" would be a number nobody can check. #252 settled that the
		// measured figure is unit coverage with the Obsidian-bound files excluded,
		// so the label has to say so — the badge is read by people who will not
		// open vitest.coverage.config.ts.
		const { alt, src } = badge(/^unit coverage /);
		expect(alt).toMatch(/^unit coverage \d+(\.\d+)?%$/);
		expect(src).toContain("/badge/unit coverage-");
	});

	it("is kept honest by a check and not by a promise", () => {
		// The number itself is compared with coverage-summary.json by
		// `npm run badges -- --check`, which CI runs straight after measuring. This
		// pins the part that check cannot see: that the badge is still there.
		expect(readme).toContain('alt="unit coverage');
	});

	it("names the minimum Obsidian version manifest.json declares", () => {
		const obsidian = badge(/^Obsidian /);
		expect(obsidian.alt).toBe(`Obsidian ${manifest.minAppVersion} or later`);
		expect(obsidian.src).toContain(`/badge/Obsidian-≥ ${manifest.minAppVersion}-`);
	});

	it("names the platforms isDesktopOnly allows", () => {
		const platforms = badge(/^Desktop/);
		const [alt, label] = manifest.isDesktopOnly
			? ["Desktop only", "desktop"]
			: ["Desktop and mobile", "desktop | mobile"];
		expect(platforms.alt).toBe(alt);
		expect(platforms.src).toContain(`/badge/platforms-${label}-`);
	});

	it("names the license package.json declares", () => {
		const license = badge(/ license$/);
		expect(license.alt).toBe(`${pkg.license} license`);
		expect(license.src).toContain(`/badge/license-${pkg.license}-`);
	});
});
