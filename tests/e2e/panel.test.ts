import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["first line of the note", "second line of the note", "third line"].join("\n");

describe("comment panel", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "inline-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(true).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".cm-editor", { timeout: 30000 });
		await dismissModals(page);

		// Create a comment through the UI so the panel reads real stored data.
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("**bold** comment body");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens from the ribbon command", async () => {
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		expect(await page.locator(".inline-comment-panel").count()).toBe(1);
	});

	it("shows the comment body, which was unreadable before the panel existed", async () => {
		await page.waitForSelector(".inline-comment-body", { timeout: 10000 });
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"bold comment body",
		);
	});

	it("renders the body as Markdown rather than raw text", async () => {
		expect(await page.locator(".inline-comment-body strong").count()).toBeGreaterThan(0);
	});

	it("quotes the commented text so the card is identifiable", async () => {
		expect(await page.locator(".inline-comment-quote").first().innerText()).toContain(
			"second line of the note",
		);
	});

	it("shows the comments when the gutter marker of a commented line is clicked", async () => {
		// The gap reported from real use: clicking a marked line opened an empty
		// composer instead of showing what was already there.
		await page.evaluate(() => window.app.workspace.detachLeavesOfType("inline-comments-panel"));
		await page.waitForTimeout(300);
		expect(await page.locator(".inline-comment-panel").count()).toBe(0);

		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);

		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		expect(await page.locator(".inline-comment-composer").count()).toBe(0);
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"bold comment body",
		);
	});
});
