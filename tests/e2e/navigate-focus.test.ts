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
const LINES = Array.from(
	{ length: 60 },
	(_, i) => `Line ${i + 1} of a note long enough to scroll.`,
);
const TARGET_LINE = 48;

/**
 * #157: navigating from the panel focused the editor, which on a phone is the
 * on-screen keyboard, laid over the line just revealed.
 *
 * Focus is read in the same synchronous block as the click: the harness keeps
 * focus only that long, so a read after an await would pass against any build.
 * The desktop case is what shows this read can see focus at all.
 *
 * The note is made the active leaf first. Obsidian desktop focuses the note when
 * a sidebar holding the active leaf collapses, which a phone does not do, and
 * that focus failed the touch case against the fixed build as well as against
 * main. With the note already active, any focus that arrives is the plugin's.
 */
describe("focus after navigating from the panel", () => {
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

	/** Click the first card's quote, and report where focus and the cursor went. */
	const jump = (): Promise<{ focusInEditor: boolean; cursorLine: number }> =>
		page.evaluate(async () => {
			const ws = window.app.workspace;
			ws.rightSplit.expand();
			const leaf = ws.getLeavesOfType("markdown")[0];
			const view = leaf.view;
			view.editor.setCursor({ line: 0, ch: 0 });
			ws.setActiveLeaf(leaf, { focus: false });
			await new Promise((r) => setTimeout(r, 600));
			(document.activeElement as HTMLElement | null)?.blur();
			(
				document.querySelector(".inline-comment-panel .inline-comment-quote") as HTMLElement
			).click();
			return {
				focusInEditor: document.activeElement?.closest(".cm-editor") != null,
				cursorLine: view.editor.getCursor().line + 1,
			};
		});

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
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + 4,
				"Far down the note.",
			);
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		}, TARGET_LINE);
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", {
			timeout: 10000,
		});
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("keeps focus out of the editor on a touch device, so no keyboard opens (#157)", async () => {
		await setTouch(true);
		expect(await jump()).toEqual({ focusInEditor: false, cursorLine: TARGET_LINE });
	});

	it("still focuses the editor on desktop, where typing carries on from the line", async () => {
		await setTouch(false);
		expect(await jump()).toEqual({ focusInEditor: true, cursorLine: TARGET_LINE });
	});
});
