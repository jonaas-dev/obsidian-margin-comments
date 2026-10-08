import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

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

	it("reads the minimum Obsidian version out of manifest.json rather than repeating it", () => {
		// It used to be a static badge, and this test existed to catch the drift.
		// Now shields reads manifest.json on main directly, so the number cannot
		// drift — what can is the badge pointing at the wrong file or field, which
		// no amount of comparing numbers would notice (#257).
		const obsidian = badge(/^Obsidian /);
		expect(obsidian.src).toContain("/badge/dynamic/json");
		expect(obsidian.src).toContain("/main/manifest.json");
		expect(obsidian.src).toContain("query=$.minAppVersion");
		// The alt text is read by people and by screen readers, so that one still
		// has to say the number, and still has to match.
		expect(obsidian.alt).toBe(`Obsidian ${manifest.minAppVersion} or later`);
	});

	it("counts downloads under the id the directory knows the plugin by", () => {
		// The stats file is keyed by manifest id, and shields draws a bad key as
		// "invalid" with a 200, so a wrong one would ship a broken badge that no
		// link checker notices (#341).
		const downloads = badge(/^downloads$/);
		expect(downloads.src).toContain(
			"/obsidianmd/obsidian-releases/master/community-plugin-stats.json",
		);
		expect(downloads.src).toContain(`query=$["${manifest.id}"].downloads`);
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

describe("README images", () => {
	// The community directory renders this README on the plugin's listing page and
	// rewrites relative image paths to raw.githubusercontent.com — but only in
	// `src`. A relative `srcset` is left alone, then resolves against
	// community.obsidian.md, where it is a 404. The icon was broken there for
	// every visitor in dark mode while light mode looked fine, because <picture>
	// prefers the <source> that matches (#339).
	it("has no relative srcset, which the directory does not rewrite", () => {
		const relative = [...readme.matchAll(/srcset="([^"]+)"/g)]
			.map((match) => match[1].trim())
			.filter((url) => !/^https?:\/\//.test(url));
		expect(relative).toEqual([]);
	});

	it("points every relative image at a file that exists", () => {
		// A typo here renders a broken image on GitHub and on the listing page
		// alike, and nothing else in the suite looks at the images folder.
		const missing = [...readme.matchAll(/(?:src|srcset)="(images\/[^"]+)"/g)]
			.map((match) => match[1])
			.filter((path) => !existsSync(path));
		expect(missing).toEqual([]);
	});
});
