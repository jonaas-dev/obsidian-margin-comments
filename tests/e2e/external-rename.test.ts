import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import { hashString } from "../../src/utils";

const NOTE = "ext.md";
const RENAMED = "ext-renamed.md";
const BODY = ["alpha beta gamma", "delta epsilon"].join("\n");

// src/storage pulls in "obsidian", which this config does not alias.
const STORAGE_DIR = ".margin-comments";
const held = (vault: string, filePath: string) =>
	join(vault, STORAGE_DIR, "held", `${hashString(filePath)}.json`);
const sidecar = (vault: string, filePath: string) =>
	join(vault, STORAGE_DIR, `${hashString(filePath)}.json`);

/**
 * #259: renamed outside Obsidian, a note arrives as `create` for the new path and
 * then `delete` for the old one — never a `rename`. Under the default behaviour the
 * delete took the comments off disk, so they lived only in memory and were gone when
 * Obsidian closed.
 */
describe("a note renamed outside Obsidian", () => {
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
		await enablePlugin(page, "margin-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);

		await page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;
			const at = 0;
			await plugin.routing.createComment(cm, note, at, at + 5, "a comment that must survive");
		}, NOTE);
		await page.waitForTimeout(1200);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("keeps its comments on disk instead of only in memory", async () => {
		expect(existsSync(sidecar(vault.path, NOTE))).toBe(true);

		// Outside Obsidian, as Finder, a terminal or a sync client would.
		renameSync(join(vault.path, NOTE), join(vault.path, RENAMED));
		await page.waitForTimeout(4000);

		// The comments left the note, which is the chosen behaviour for a delete...
		expect(existsSync(sidecar(vault.path, NOTE))).toBe(false);
		// ...but they are still on disk, which is what #259 is about. Before the fix
		// this file did not exist and the comments lived only until Obsidian closed.
		expect(existsSync(held(vault.path, NOTE))).toBe(true);

		const stored = await page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			return (await plugin.storage.releaseComments(note))?.length ?? 0;
		}, NOTE);
		expect(stored).toBe(1);
	});
});
