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
const BODY = ["alpha beta gamma", "delta epsilon zeta"].join("\n");
const LONG = Array.from(
	{ length: 30 },
	(_, i) => `Paragraph ${i + 1} of a comment long enough to be clipped.`,
).join("\n\n");

/**
 * A card's body is measured for clipping once its Markdown has rendered. A card
 * painted while the panel was not on screen measured 0, so a long body was never
 * clipped. A refresh on the panel's own activation used to repaint it, which hid
 * this until #158 removed that refresh (#169).
 */
describe("clipping a long body painted while the panel was hidden", () => {
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

		await page.evaluate(async (long: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.routing.createComment(cm, leaf.view.file.path, at, at + 4, long);
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		}, LONG);
		await page.waitForSelector(".inline-comment-panel .inline-comment-body", {
			timeout: 10000,
		});
		await page.waitForTimeout(800);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("clips it once the panel comes on screen (#169)", async () => {
		const result = await page.evaluate(async () => {
			const ws = window.app.workspace;
			const plugin = window.app.plugins.plugins["margin-comments"];
			ws.rightSplit.collapse();
			await new Promise((r) => setTimeout(r, 600));
			const hiddenAtPaint = !(
				document.querySelector(".inline-comment-panel") as HTMLElement
			).isShown();
			await plugin.refresh();
			await new Promise((r) => setTimeout(r, 500));
			ws.rightSplit.expand();
			await new Promise((r) => setTimeout(r, 1000));
			return {
				hiddenAtPaint,
				clipped:
					document.querySelector(
						".inline-comment-panel .inline-comment-body.is-clipped",
					) !== null,
				control:
					document.querySelector(
						".inline-comment-panel .inline-comment-showmore.is-available",
					) !== null,
			};
		});
		// Guard: a panel painted on screen measures its bodies the ordinary way.
		expect(result.hiddenAtPaint).toBe(true);
		expect(result).toEqual({ hiddenAtPaint: true, clipped: true, control: true });
	});
});
