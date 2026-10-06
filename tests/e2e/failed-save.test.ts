import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
// src/utils has no imports of its own; src/storage pulls in "obsidian", which the
// E2E config does not alias because these tests drive a real Obsidian instead.
import { hashString } from "../../src/utils";

const STORAGE_DIR = ".margin-comments";

const NOTE = "note.md";
const BODY = ["alpha beta gamma", "delta epsilon", "eta theta"].join("\n");

/**
 * #266: the composer cleared itself before the write and dropped the promise, so
 * a rejected save left the typed text gone and nothing on screen. A sidecar a
 * newer plugin version wrote is the rejection we can stage: every write to that
 * note is refused, by design.
 */
// A version far above any this plugin writes, so the staging does not quietly
// stop working the day FORMAT_VERSION is raised.
const NEWER_SIDECAR = JSON.stringify({ version: 999, comments: [] });

describe("a comment the store refuses to save", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({
			[NOTE]: BODY,
			[`${STORAGE_DIR}/${hashString(NOTE)}.json`]: NEWER_SIDECAR,
		});
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
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("keeps what was typed, and says why, instead of closing on a failed write", async () => {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(0).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });

		const TYPED = "a comment that cannot be stored";
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(TYPED);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(2000);

		const after = await page.evaluate(() => {
			const input = document.querySelector(
				".inline-comment-composer-input",
			) as HTMLTextAreaElement | null;
			return {
				stillOpen: document.querySelector(".inline-comment-composer") !== null,
				text: input?.value ?? null,
				notice:
					document.querySelector(".notice")?.textContent ??
					document.querySelector(".notice-container")?.textContent ??
					null,
			};
		});

		// The composer is the only place that text exists; closing it loses it.
		expect(after.stillOpen).toBe(true);
		expect(after.text).toBe(TYPED);
		// And the reader is told, rather than left wondering why nothing happened.
		expect(after.notice ?? "").toContain("newer version");

		// Nothing was written either, so the refusal is real and not cosmetic.
		const stored = await page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			return (await plugin.storage.getCommentsForFile(note)).length;
		}, NOTE);
		expect(stored).toBe(0);
	});
});
