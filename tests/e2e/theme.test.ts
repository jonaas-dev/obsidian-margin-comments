import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOTE = "note.md";
const BODY = ["first line of the note", "second line of the note", "third line"].join("\n");

/**
 * The plugin's own painted surfaces, and the property each one takes from the
 * theme. Anything hardcoded would hold the same value in both themes.
 */
const SURFACES: Array<[string, string]> = [
	[".inline-comment-quote", "color"],
	[".inline-comment-quote", "border-left-color"],
	[".inline-comment-body", "color"],
	[".inline-comment-author", "color"],
	[".inline-comment-filter", "color"],
	[".inline-comment-replybox-input", "background-color"],
	[".inline-comment-active-line", "background-color"],
];

/** Values no theme would pick, so a match cannot be a coincidence. */
const FAKE_THEME: Record<string, string> = {
	"--text-normal": "rgb(1, 2, 3)",
	"--text-muted": "rgb(4, 5, 6)",
	"--text-accent": "rgb(7, 8, 9)",
	"--background-modifier-form-field": "rgb(10, 11, 12)",
};

describe("theme awareness", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);

		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("a comment to paint");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-body", { timeout: 10000 });
		await page.waitForTimeout(500);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	/** Computed values for every surface, under the named built-in theme. */
	async function paintedUnder(theme: string): Promise<Record<string, string>> {
		return page.evaluate(
			async ([name, surfaces]: [string, Array<[string, string]>]) => {
				(window.app as any).changeTheme(name);
				await new Promise((resolve) => setTimeout(resolve, 400));
				const out: Record<string, string> = {};
				for (const [selector, property] of surfaces) {
					const el = document.querySelector(selector);
					out[`${selector} ${property}`] = el
						? getComputedStyle(el).getPropertyValue(property)
						: "MISSING";
				}
				return out;
			},
			[theme, SURFACES],
		);
	}

	it("finds every surface it claims to be checking", async () => {
		// A selector that matches nothing reports "MISSING" in both themes, which
		// would compare equal and read as a hardcoded colour — or, if the test
		// only asserted difference, would quietly shrink the audit to nothing.
		const light = await paintedUnder("moonstone");
		expect(Object.values(light)).not.toContain("MISSING");
	});

	it("repaints every surface when the theme changes", async () => {
		const light = await paintedUnder("moonstone");
		const dark = await paintedUnder("obsidian");

		const unchanged = Object.keys(light).filter((key) => light[key] === dark[key]);
		expect(unchanged).toEqual([]);
	});

	it("follows a theme's variables rather than merely differing between two", async () => {
		// The stronger claim, and the one a community theme actually exercises:
		// the colour is read from the variable, not chosen from a palette that
		// happens to have a light and a dark entry. Set on body rather than in a
		// stylesheet so it outranks the theme-light/theme-dark class it overrides.
		const painted = await page.evaluate(
			async ([theme, surfaces]: [Record<string, string>, Array<[string, string]>]) => {
				(window.app as any).changeTheme("moonstone");
				await new Promise((resolve) => setTimeout(resolve, 400));
				for (const [name, value] of Object.entries(theme)) {
					document.body.style.setProperty(name, value);
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
				const out: Record<string, string> = {};
				for (const [selector, property] of surfaces) {
					const el = document.querySelector(selector);
					out[`${selector} ${property}`] = el
						? getComputedStyle(el).getPropertyValue(property)
						: "MISSING";
				}
				for (const name of Object.keys(theme)) document.body.style.removeProperty(name);
				return out;
			},
			[FAKE_THEME, SURFACES],
		);

		expect(painted[".inline-comment-body color"]).toBe(FAKE_THEME["--text-normal"]);
		expect(painted[".inline-comment-quote color"]).toBe(FAKE_THEME["--text-muted"]);
		expect(painted[".inline-comment-author color"]).toBe(FAKE_THEME["--text-muted"]);
		expect(painted[".inline-comment-quote border-left-color"]).toBe(
			FAKE_THEME["--text-accent"],
		);
		expect(painted[".inline-comment-replybox-input background-color"]).toBe(
			FAKE_THEME["--background-modifier-form-field"],
		);
		// The highlight is the accent mixed down, so it is neither the accent nor
		// the fallback: it carries the accent's channels at 12%. color-mix computes
		// to color(srgb ...) rather than rgba(), and 7/8/9 over 255 is what those
		// fractions are — measured, because the format is not what it looks like
		// in the stylesheet.
		expect(painted[".inline-comment-active-line background-color"]).toBe(
			"color(srgb 0.027451 0.0313726 0.0352941 / 0.12)",
		);
	});

	it("mixes the highlight rather than falling back to a flat tint", async () => {
		// The stylesheet declares background-color twice so a renderer without
		// color-mix keeps the flat one. Where color-mix exists — every desktop
		// build at minAppVersion 1.5 — the mixed value must be the one that wins,
		// or the fallback is silently the only thing anyone ever sees.
		const supported = await page.evaluate(() =>
			CSS.supports("background-color", "color-mix(in srgb, red 12%, transparent)"),
		);
		expect(supported).toBe(true);

		const painted = await page.evaluate(() => {
			const el = document.querySelector(".inline-comment-active-line");
			return el ? getComputedStyle(el).backgroundColor : "MISSING";
		});
		// A mix with transparent is translucent and computes as color(srgb ... / a);
		// the flat fallback is an opaque rgb(). Asserting the alpha rather than
		// just the function name: color(srgb r g b) with no alpha would mean the
		// mix ran and the percentage was lost.
		expect(painted).toMatch(/^color\(srgb [\d.]+ [\d.]+ [\d.]+ \/ 0\.12\)$/);
	});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
