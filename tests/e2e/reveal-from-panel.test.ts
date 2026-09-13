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

const NOTE = "note.md";
const LINES = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a note long enough to scroll.`);
const TARGET_LINE = 48;

/**
 * #131: tapping a card's quote on a phone moved the cursor behind the panel.
 *
 * The sidebars on a touch device are drawers over the note, so the jump
 * happened out of sight. Driven with `plugin.touch`, as the touch suite is.
 */
describe("navigating from the panel", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function setTouch(on: boolean): Promise<void> {
		await page.evaluate(async (value: boolean) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.touch = value;
			await plugin.refresh();
		}, on);
		await page.waitForTimeout(700);
	}

	/** Expand the panel's sidebar and put the caret back at the top of the note. */
	async function prepare(): Promise<boolean> {
		const expanded = await page.evaluate(async () => {
			const ws = window.app.workspace;
			ws.rightSplit.expand();
			const leaf = ws.getLeavesOfType("markdown")[0];
			leaf.view.editor.setCursor({ line: 0, ch: 0 });
			await new Promise((r) => setTimeout(r, 600));
			return !ws.rightSplit.collapsed;
		});
		return expanded;
	}

	const state = (): Promise<{ collapsed: boolean; cursorLine: number }> =>
		page.evaluate(() => ({
			collapsed: window.app.workspace.rightSplit.collapsed,
			cursorLine: window.app.workspace.getLeavesOfType("markdown")[0].view.editor.getCursor().line + 1,
		}));

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: LINES.join("\n") });
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

		await page.evaluate(async (target: number) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf(`Line ${target} `);
			await plugin.routing.createComment(cm, leaf.view.file.path, at, at + 4, "Far down the note.");
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		}, TARGET_LINE);
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", { timeout: 10000 });
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("closes the drawer after jumping from a quote on a touch device (#131)", async () => {
		await setTouch(true);
		expect(await prepare()).toBe(true);
		await page.locator(".inline-comment-panel .inline-comment-quote").first().click();
		await page.waitForTimeout(900);
		expect(await state()).toEqual({ collapsed: true, cursorLine: TARGET_LINE });
	});

	it("closes it after opening a card from the all-notes view too", async () => {
		expect(await prepare()).toBe(true);
		await page.selectOption(".inline-comment-scope", "vault");
		await page.waitForSelector(".inline-comment-section-head", { timeout: 10000 });
		await page.locator(".inline-comment-section-head").first().click();
		await page.waitForSelector(".inline-comment-section-body .inline-comment-card", { timeout: 10000 });
		await page.locator(".inline-comment-section-body .inline-comment-body").first().click();
		await page.waitForTimeout(1200);
		expect(await state()).toEqual({ collapsed: true, cursorLine: TARGET_LINE });

		await page.evaluate(() => window.app.workspace.rightSplit.expand());
		await page.selectOption(".inline-comment-scope", "note");
		await page.waitForTimeout(700);
	});

	it("leaves a pinned desktop sidebar where it is", async () => {
		await setTouch(false);
		expect(await prepare()).toBe(true);
		await page.locator(".inline-comment-panel .inline-comment-quote").first().click();
		await page.waitForTimeout(900);
		expect(await state()).toEqual({ collapsed: false, cursorLine: TARGET_LINE });
	});
});
