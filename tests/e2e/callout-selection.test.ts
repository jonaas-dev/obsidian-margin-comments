import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { length: number } };
	dispatch(spec: unknown): void;
}

const NOTE = "note.md";
const BODY = [
	"A paragraph above the callout.",
	"",
	"> [!note] A callout title",
	"> Callout sentence with a distinctive word.",
	"",
	"A paragraph below with a closing word.",
].join("\n");

/**
 * #421: double-clicking a word in a rendered callout selects it in the DOM only,
 * CodeMirror's selection stays empty, and "Add comment to selection" fell back to
 * a whole-line comment.
 */
describe("commenting words selected in a rendered callout", () => {
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
			await window.app.workspace
				.getLeaf(false)
				.openFile(file, { state: { mode: "source", source: false } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("stores the selected word, not the line", async () => {
		// Caret below the callout so live preview renders it.
		await page.evaluate(() => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		});
		await page.waitForSelector(".cm-callout", { timeout: 30000 });
		await page.waitForTimeout(800);
		const pt = await page.evaluate(() => {
			const p = document.querySelector(".cm-callout .callout-content p")!;
			const text = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode()!;
			const at = (text.textContent ?? "").indexOf("distinctive");
			const range = document.createRange();
			range.setStart(text, at + 3);
			range.setEnd(text, at + 5);
			const r = range.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		});
		await page.mouse.dblclick(pt.x, pt.y);
		await page.waitForTimeout(400);
		const selected = await page.evaluate(() => window.getSelection()!.toString().trim());
		expect(selected).toBe("distinctive");

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:add-comment");
		});
		await page.waitForSelector(".inline-comment-composer", { timeout: 10000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("About that word.");
		await page.locator(".inline-comment-composer .mod-cta").click();

		const stored = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const path = window.app.workspace.getActiveFile()!.path;
			for (let i = 0; i < 50; i++) {
				const all = await plugin.storage.getCommentsForFile(path);
				if (all.length > 0)
					return all.map(
						(c: { anchor: { selectedText: string; isLineComment: boolean } }) => ({
							text: c.anchor.selectedText,
							line: c.anchor.isLineComment,
						}),
					);
				await new Promise((r) => setTimeout(r, 200));
			}
			return [];
		});
		expect(stored).toEqual([{ text: "distinctive", line: false }]);
	});
});
