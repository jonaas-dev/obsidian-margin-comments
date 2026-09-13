import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["first line", "the commented line", "third line"].join("\n");

describe("appearance settings", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/**
	 * Change a setting the way the settings tab will, then make the plugin act
	 * on it. Nothing is reloaded: the acceptance criterion is that a change takes
	 * hold in the open editor.
	 */
	async function setSetting(key: string, value: unknown): Promise<void> {
		await page.evaluate(
			async ([name, next]: [string, unknown]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				(plugin.settings as Record<string, unknown>)[name] = next;
				plugin.applyHighlightColour();
				window.app.workspace.trigger("editor-change");
			},
			[key, value],
		);
		await page.waitForTimeout(1000);
	}

	const highlightVariable = (): Promise<string> =>
		page.evaluate(() =>
			getComputedStyle(document.body).getPropertyValue("--ic-highlight").trim(),
		);

	async function hoverGutter(): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(2).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForTimeout(600);
	}

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
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("a comment to look at");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("marks the commented line in the gutter to begin with", async () => {
		expect(await page.locator(".inline-comment-marker-active").count()).toBe(1);
	});

	it("sets no highlight colour of its own until one is chosen", async () => {
		// Unset, not set to a copy of the accent: the stylesheet falls back, so
		// following the theme costs no plugin code.
		expect(await highlightVariable()).toBe("");
	});

	it("hides every gutter marker when the setting is switched off", async () => {
		await setSetting("showGutterIcons", false);
		expect(await page.locator(".inline-comment-marker-active").count()).toBe(0);
	});

	it("hides the hover affordance too, not only the commented lines", async () => {
		await hoverGutter();
		expect(await page.locator(".inline-comment-marker").count()).toBe(0);
	});

	it("brings the markers back without reopening the note", async () => {
		await setSetting("showGutterIcons", true);
		expect(await page.locator(".inline-comment-marker-active").count()).toBe(1);
	});

	it("tints the line with a chosen colour, live", async () => {
		await setSetting("highlightColor", "#ff8800");
		expect(await highlightVariable()).toBe("#ff8800");
		const shadow = await page.evaluate(
			() =>
				getComputedStyle(document.querySelector(".inline-comment-active-line")!).boxShadow,
		);
		// Asserted on the rendered line, not only the variable: a property nobody
		// reads is set just as successfully as one that paints.
		expect(shadow).toContain("255, 136, 0");
	});

	it("hands the line back to the theme when the colour is cleared", async () => {
		await setSetting("highlightColor", "theme");
		expect(await highlightVariable()).toBe("");
		const shadow = await page.evaluate(
			() =>
				getComputedStyle(document.querySelector(".inline-comment-active-line")!).boxShadow,
		);
		expect(shadow).not.toContain("255, 136, 0");
	});

	it("ignores a stored colour that is not one, rather than painting nothing", async () => {
		// data.json is hand-edited; a typo written straight through would clear
		// the tint and read as the highlights breaking.
		await setSetting("highlightColor", "not a colour");
		expect(await highlightVariable()).toBe("");
		expect(await page.locator(".inline-comment-active-line").count()).toBe(1);
	});
});
