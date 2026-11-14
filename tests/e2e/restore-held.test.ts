import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import { hashString } from "../../src/utils";

const NOTE = "note.md";
const GONE = "gone.md";
const STORAGE_DIR = ".margin-comments";
const heldPath = (vault: string) => join(vault, STORAGE_DIR, "held", `${hashString(GONE)}.json`);

const comment = (id: string, parentId: string | null) => ({
	id,
	filePath: GONE,
	anchor: {
		selectedText: "alpha",
		textHash: hashString("alpha"),
		isLineComment: false,
		contextBefore: "",
		contextAfter: " beta",
		lineHint: 0,
		startOffset: 0,
		endOffset: 5,
	},
	content: `held ${id}`,
	author: "someone",
	createdAt: 1000,
	updatedAt: 2000,
	resolved: false,
	parentId,
});

/**
 * #432: comments held for a note that never came back, restored to another note
 * through the command.
 */
describe("restoring held comments (#432)", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({
			[NOTE]: "alpha beta gamma",
			[`${STORAGE_DIR}/held/${hashString(GONE)}.json`]: JSON.stringify({
				version: 1,
				filePath: GONE,
				comments: [comment("h1", null), comment("h2", "h1")],
			}),
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

	it("is offered while something is held, and lists the entry in the picker", async () => {
		const offered = await page.evaluate(() => {
			const command = window.app.commands.commands["margin-comments:restore-held-comments"];
			return command.editorCheckCallback(true, window.app.workspace.activeEditor?.editor, {
				file: window.app.workspace.getActiveFile(),
			});
		});
		expect(offered).toBe(true);

		await page.evaluate(() => {
			void window.app.commands.executeCommandById("margin-comments:restore-held-comments");
		});
		const attached = await page
			.waitForSelector(".prompt .suggestion-item", { timeout: 5000 })
			.then(() => true)
			.catch(() => false);
		if (attached) {
			const label = await page.textContent(".prompt .suggestion-item");
			expect(label).toContain(GONE);
			expect(label).toContain("1 open thread");
			await page.click(".prompt .suggestion-item");
		} else {
			// The modal does not attach here (docs/e2e.md); drive the method behind it.
			await page.evaluate(
				async ([from, to]: string[]) => {
					await window.app.plugins.plugins["margin-comments"].restoreHeldTo(from, to);
				},
				[GONE, NOTE],
			);
		}

		await page.waitForSelector(".inline-comment-panel .inline-comment-card", {
			timeout: 10000,
		});
		const stored = JSON.parse(
			readFileSync(join(vault.path, STORAGE_DIR, `${hashString(NOTE)}.json`), "utf8"),
		);
		expect(stored.comments.map((c: { id: string }) => c.id).sort()).toEqual(["h1", "h2"]);
		expect(stored.comments.every((c: { filePath: string }) => c.filePath === NOTE)).toBe(true);
		expect(existsSync(heldPath(vault.path))).toBe(false);
	});

	it("is unavailable once nothing is held", async () => {
		const available = await page.evaluate(() => {
			const command = window.app.commands.commands["margin-comments:restore-held-comments"];
			return command.editorCheckCallback(true, window.app.workspace.activeEditor?.editor, {
				file: window.app.workspace.getActiveFile(),
			});
		});
		expect(available).toBe(false);
	});
});
