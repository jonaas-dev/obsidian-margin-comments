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

/**
 * #158: a tap inside the panel on a phone makes the panel's own leaf active, and
 * the plugin refreshed on every activation. The rebuild landed between touchend
 * and the synthesized click, so in the all-notes view the click hit whatever
 * had moved under the finger: a section head, which collapsed.
 *
 * A rebuild is detected by the cards being new nodes. The second case checks
 * that detector against an activation that must still rebuild.
 */
describe("activating the panel's own leaf", () => {
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

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const doc = cm.state.doc.toString();
			for (const word of ["beta", "epsilon"]) {
				const at = doc.indexOf(word);
				await plugin.createComment(cm, leaf.view.file.path, at, at + word.length, `On ${word}.`);
			}
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", { timeout: 10000 });
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("does not rebuild the panel when the panel itself becomes active (#158)", async () => {
		const result = await page.evaluate(async () => {
			const ws = window.app.workspace;
			ws.setActiveLeaf(ws.getLeavesOfType("markdown")[0], { focus: true });
			await new Promise((r) => setTimeout(r, 600));
			const panelLeaf = ws.getLeavesOfType("margin-comments-panel")[0];
			const before = document.querySelector(".inline-comment-panel .inline-comment-card");
			ws.setActiveLeaf(panelLeaf, { focus: true });
			await new Promise((r) => setTimeout(r, 800));
			return {
				panelActive: (ws as unknown as { activeLeaf: unknown }).activeLeaf === panelLeaf,
				hadCard: before !== null,
				survived: before?.isConnected ?? null,
			};
		});
		// Guard: if the panel never became active, no refresh was ever at stake.
		expect(result.panelActive).toBe(true);
		expect(result.hadCard).toBe(true);
		expect(result.survived).toBe(true);
	});

	it("still rebuilds it when a note becomes active again", async () => {
		const result = await page.evaluate(async () => {
			const ws = window.app.workspace;
			const before = document.querySelector(".inline-comment-panel .inline-comment-card");
			ws.setActiveLeaf(ws.getLeavesOfType("markdown")[0], { focus: true });
			await new Promise((r) => setTimeout(r, 800));
			return { hadCard: before !== null, survived: before?.isConnected ?? null };
		});
		expect(result.hadCard).toBe(true);
		expect(result.survived).toBe(false);
	});
});
