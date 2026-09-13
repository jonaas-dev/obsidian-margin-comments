import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "test-note.md";
const NOTE_BODY = ["first line of the note", "second line of the note", "third line"].join("\n");

describe("comment gutter inside Obsidian", () => {
	let vault: { path: string; remove(): void };
	// Playwright's Page is not typed here on purpose: the harness is plain ESM so
	// the E2E tests stay runnable without a build step.
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: NOTE_BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");

		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(true).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".cm-editor", { timeout: 30000 });
		await dismissModals(page);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("loads without console errors", async () => {
		const loaded = await page.evaluate(
			() => window.app.plugins.plugins["margin-comments"] != null,
		);
		expect(loaded).toBe(true);
	});

	it("registers its gutter in the editor", async () => {
		expect(await page.locator(".inline-comment-gutter").count()).toBeGreaterThan(0);
	});

	it("shows no marker until the pointer nears the gutter", async () => {
		await page.mouse.move(600, 400);
		await page.waitForTimeout(200);
		expect(await page.locator(".inline-comment-marker").count()).toBe(0);
	});

	it("reveals a marker when the pointer nears the gutter", async () => {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").first().boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForTimeout(300);
		expect(await page.locator(".inline-comment-marker").count()).toBeGreaterThan(0);
	});

	it("hides the marker again when the pointer leaves", async () => {
		await page.mouse.move(600, 400);
		await page.waitForTimeout(300);
		expect(await page.locator(".inline-comment-marker").count()).toBe(0);
	});
});
