import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { toString(): string } };
}

const ACTIVE = "active.md";
const OTHER = "other.md";
const TARGET_LINE = 30;
const note = (name: string): string =>
	Array.from({ length: 40 }, (_, i) => `${name} line ${i + 1}.`).join("\n");

/**
 * #155: in the all-notes view, a card's quote revealed its line in whichever
 * note was active, not in the note the card belongs to.
 *
 * Both notes are long enough to hold the line, so a reveal against the wrong
 * note moves that note's cursor rather than doing nothing, and only the active
 * file tells the two apart.
 */
describe("the quote of a card in the all-notes view", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const openNote = (path: string): Promise<void> =>
		page.evaluate(async (p: string) => {
			const file = window.app.vault.getAbstractFileByPath(p);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
			window.app.workspace
				.getLeavesOfType("markdown")[0]
				.view.editor.setCursor({ line: 0, ch: 0 });
		}, path);

	beforeAll(async () => {
		vault = createTempVault({ [ACTIVE]: note("Active"), [OTHER]: note("Other") });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await openNote(OTHER);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);

		await page.evaluate(async (target: number) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			// The trailing period, so line 3 does not match the start of line 30.
			const at = cm.state.doc.toString().indexOf(`Other line ${target}.`);
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + 5,
				"On the other note.",
			);
		}, TARGET_LINE);

		await openNote(ACTIVE);
		await page.evaluate(() =>
			window.app.commands.executeCommandById("margin-comments:toggle-comments-panel"),
		);
		await page.waitForSelector(".inline-comment-panel .inline-comment-scope", {
			timeout: 10000,
		});
		await page.selectOption(".inline-comment-scope", "vault");
		await page.waitForSelector(".inline-comment-section-head", { timeout: 10000 });
		await page.locator(".inline-comment-section-head").first().click();
		await page.waitForSelector(".inline-comment-section-body button.inline-comment-quote", {
			timeout: 10000,
		});
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens the card's note at the thread's line (#155)", async () => {
		const before = await page.evaluate(() => ({
			active: window.app.workspace.getActiveFile()?.path,
			sections: Array.from(
				document.querySelectorAll(".inline-comment-section-path-text"),
			).map((el) => el.textContent),
		}));
		// Guard: the card must belong to a note that is not the active one, or a
		// reveal against the active note would be indistinguishable from the fix.
		expect(before).toEqual({ active: ACTIVE, sections: [OTHER] });

		await page
			.locator(".inline-comment-section-body button.inline-comment-quote")
			.first()
			.click();
		await page.waitForTimeout(1200);

		const after = await page.evaluate(() => ({
			active: window.app.workspace.getActiveFile()?.path,
			line:
				window.app.workspace.getLeavesOfType("markdown")[0].view.editor.getCursor().line +
				1,
		}));
		expect(after).toEqual({ active: OTHER, line: TARGET_LINE });
	});
});
