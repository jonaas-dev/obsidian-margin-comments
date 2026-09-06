import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["first line of the note", "second line of the note", "third line"].join("\n");

describe("panel sorting", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Comment a line through the UI, the way a person would. */
	async function commentOnLine(index: number, body: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(index).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(body);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1200);
	}

	async function chooseSort(order: string): Promise<void> {
		await page.selectOption(".inline-comment-sort", order);
		await page.waitForTimeout(600);
	}

	const quotes = () => page.locator(".inline-comment-quote").allInnerTexts();

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

		// Earlier line commented first, so document order and creation order
		// disagree — otherwise both sorts would produce the same list and prove
		// nothing.
		await commentOnLine(0, "comment on the first line");
		await commentOnLine(2, "comment on the third line");

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens in document order", async () => {
		expect(await page.locator(".inline-comment-card").count()).toBe(2);
		expect((await quotes())[0]).toContain("first line of the note");
	});

	it("puts the newest thread first under 'Date created'", async () => {
		await chooseSort("date");
		expect((await quotes())[0]).toContain("third line");
	});

	it("reorders on the reply, not the root, under 'Last activity'", async () => {
		// The first-line thread is the older of the two; a reply to it has to
		// outrank a newer thread nobody has touched since.
		await page.locator(".inline-comment-card").last().hover();
		const replyInput = page.locator(".inline-comment-replybox-input").last();
		await replyInput.click();
		await replyInput.fill("a reply that revives the older thread");
		await page.locator(".inline-comment-send").last().click();
		await page.waitForTimeout(1500);

		await chooseSort("lastActivity");
		expect((await quotes())[0]).toContain("first line of the note");
	});

	it("stores the sort order in data.json, so it survives a restart", async () => {
		const data = JSON.parse(
			readFileSync(`${vault.path}/.obsidian/plugins/inline-comments/data.json`, "utf8"),
		);
		expect(data.sortOrder).toBe("lastActivity");
	});

	it("does not go back to disk to change the sort order", async () => {
		// Filter and sort are view decisions over data already loaded. Re-reading
		// the sidecar on every click would be an I/O round trip for bytes the
		// panel is holding.
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["inline-comments"];
			const storage = plugin.storage;
			window.__reads = 0;
			const original = storage.getCommentsForFile.bind(storage);
			storage.getCommentsForFile = (path: string) => {
				window.__reads++;
				return original(path);
			};
		});

		await chooseSort("position");
		await page.locator(".inline-comment-filter", { hasText: "Open" }).click();
		await page.waitForTimeout(600);

		expect(await page.evaluate(() => window.__reads)).toBe(0);
		// And the panel really did redraw, rather than sitting inert.
		expect((await quotes())[0]).toContain("first line of the note");
	});
});
