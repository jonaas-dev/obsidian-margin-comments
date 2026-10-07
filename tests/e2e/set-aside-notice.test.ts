import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import { hashString } from "../../src/utils";

const NOTE = "note.md";
const STORAGE_DIR = ".margin-comments";

/**
 * #318: a sidecar that cannot be read is renamed rather than deleted, which is
 * right, and then never mentioned again, which is not. On a vault with a noisy
 * sync they accumulate inside a hidden folder nobody opens.
 *
 * Driven end to end because the panel is where the count has to appear, and
 * because the files have to be on disk before Obsidian starts to be realistic.
 */
describe("sidecars set aside after a failure", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({
			[NOTE]: "alpha beta gamma",
			[`${STORAGE_DIR}/${hashString(NOTE)}.json`]: JSON.stringify({
				version: 1,
				filePath: NOTE,
				comments: [],
			}),
			[`${STORAGE_DIR}/aaaa.json.unreadable-1700000000000`]: "not json at all",
			[`${STORAGE_DIR}/bbbb.json.invalid-1700000000001`]: '{"comments":[]}',
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
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("are counted in the all-notes view, with the folder named", async () => {
		// The note scope is about one note; this is about the vault, so it belongs
		// here and nowhere else.
		await page.evaluate(() => {
			const select = document.querySelector<HTMLSelectElement>(".inline-comment-scope");
			if (select === null) throw new Error("no scope control");
			select.value = "vault";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await page.waitForSelector(".inline-comment-set-aside", { timeout: 10000 });

		const text = await page.locator(".inline-comment-set-aside").first().innerText();
		expect(text).toContain("2 sidecar files");
		expect(text).toContain(STORAGE_DIR);
	});

	it("say nothing in the note scope, which is not about the vault", async () => {
		await page.evaluate(() => {
			const select = document.querySelector<HTMLSelectElement>(".inline-comment-scope");
			if (select === null) throw new Error("no scope control");
			select.value = "note";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await page.waitForTimeout(800);
		expect(await page.locator(".inline-comment-set-aside").count()).toBe(0);
	});
});
