import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["alpha beta gamma", "delta epsilon", "eta theta"].join("\n");

/**
 * #267: the reply field keeps its draft on blur on purpose, but it lives in the
 * panel's DOM and every repaint starts with container.empty(). Clicking back into
 * the note is a repaint, so half-written text did not survive looking away.
 */
describe("a half-written reply", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const stored = (): Promise<string> =>
		page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile(note);
			return comments.map((c: { content: string }) => c.content).join(" | ");
		}, NOTE);

	const repaint = (): Promise<void> =>
		page.evaluate(async () => {
			await window.app.plugins.plugins["margin-comments"].refresh();
		});

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
			await plugin.routing.createComment(cm, note, 0, 5, "the thread being replied to");
		}, NOTE);
		await page.waitForTimeout(1200);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", { timeout: 10000 });
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("survives a repaint of the panel", async () => {
		const DRAFT = "half-written and not sent yet";
		// The field only shows on hover on a desktop; it folds away otherwise (#136).
		await page.locator(".inline-comment-card").first().hover();
		await page.waitForTimeout(400);
		await page.locator(".inline-comment-replybox-input").first().click();
		await page.locator(".inline-comment-replybox-input").first().fill(DRAFT);

		await repaint();
		await page.waitForTimeout(800);

		const after = await page.evaluate(() => {
			const input = document.querySelector(
				".inline-comment-panel .inline-comment-replybox-input",
			) as HTMLTextAreaElement | null;
			return {
				text: input?.value ?? null,
				open: document.querySelector(".inline-comment-replybox.is-active") !== null,
			};
		});

		expect(after.text).toBe(DRAFT);
		// Standing open where it was, rather than folded back up under the card.
		expect(after.open).toBe(true);
	});

	it("does not let an edit box outlive its own listener", async () => {
		// #114 made an outside press commit an edit. A repaint removes the box
		// without finish() running, so its document listener stayed registered and
		// fired for a box that no longer existed — saving a draft at the next press
		// anywhere, however much later.
		const body = await stored();
		await page.locator(".inline-comment-card").first().hover();
		await page.waitForTimeout(400);
		await page.locator('[aria-label="Edit comment"]').first().click({ force: true });
		await page.waitForSelector(".inline-comment-editor-input", { timeout: 5000 });
		await page.locator(".inline-comment-editor-input").first().fill("an edit nobody confirmed");

		await repaint();
		await page.waitForTimeout(800);

		// Cancelled deliberately: the restored box goes, and with it its own
		// listener. Only a listener left over from before the repaint could still
		// act on the text.
		//
		// The Cancel button rather than Escape: the harness cannot hold focus in a
		// textarea, so a keydown never reaches it. Both take the same path, and
		// edit-in-place.test.ts makes the same substitution for the same reason.
		await page.locator('[aria-label="Cancel edit"]').first().click({ force: true });
		await page.waitForTimeout(300);
		await page.locator(".inline-comment-panel").click({ position: { x: 5, y: 5 } });
		await page.waitForTimeout(1500);

		expect(await stored()).toBe(body);
	});
});
