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

interface EditorViewLike {
	state: { doc: { toString(): string } };
}

/**
 * #264: two changes to one comment, the second made from the card as it was drawn
 * before the first landed. The press on Resolve commits the open edit (#114) and its
 * click resolves the comment the card was drawn with, which still holds the old body.
 */
describe("a change made from a card drawn before the last one landed", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const stored = (): Promise<{ content: string; resolved: boolean }[]> =>
		page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile(note);
			return comments.map((c: { content: string; resolved: boolean }) => ({
				content: c.content,
				resolved: c.resolved,
			}));
		}, NOTE);

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

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + 4,
				"The original body.",
			);
		});
		await page.waitForTimeout(1200);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", {
			timeout: 10000,
		});
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("keeps an edit when Resolve is pressed while the edit box is still open", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.waitForTimeout(400);
		await page.locator('[aria-label="Edit comment"]').first().click({ force: true });
		await page.waitForSelector(".inline-comment-editor-input", { timeout: 5000 });
		await page.locator(".inline-comment-editor-input").first().fill("The edited body.");

		// Pressed straight away, without Save: the press commits the edit.
		await page
			.locator('.inline-comment-card [aria-label="Resolve"]')
			.first()
			.click({ force: true });
		await page.waitForTimeout(2500);

		// Compared as text so a failure prints what was stored.
		expect(JSON.stringify(await stored())).toBe(
			JSON.stringify([{ content: "The edited body.", resolved: true }]),
		);
	});
});
