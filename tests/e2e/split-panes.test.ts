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
 * #83: one note, two panes.
 *
 * Each pane is its own CodeMirror instance with its own decorations, and the
 * plugin used to push to whichever leaf it found first — so the second pane
 * showed the note as though it carried no comments.
 */
describe("a note open in two panes", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/**
	 * Markers and highlights per editor, in pane order.
	 *
	 * The highlight here is the *mark* layer: this suite comments on a word, and
	 * since #100 a word comment marks its range rather than tinting its line.
	 */
	const perPane = (): Promise<{ markers: number[]; highlights: number[] }> =>
		page.evaluate(() => {
			const editors = Array.from(document.querySelectorAll(".cm-editor"));
			return {
				markers: editors.map((e) => e.querySelectorAll(".inline-comment-marker-active").length),
				highlights: editors.map((e) => e.querySelectorAll(".inline-comment-active-range").length),
			};
		});

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "inline-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["inline-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.createComment(cm, leaf.view.file.path, at, at + 4, "a comment on beta");
		});
		await page.waitForTimeout(1500);

		// The same note again, beside it.
		await page.evaluate(async () => {
			const path = window.app.workspace.getLeavesOfType("markdown")[0].view.file.path;
			const split = window.app.workspace.getLeaf("split");
			await split.setViewState({ type: "markdown", state: { file: path, mode: "source" } });
		});
		await page.waitForTimeout(1500);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens the second pane at all, so the counts below mean something", async () => {
		// Without this, one pane failing to open would read as two panes agreeing.
		expect(await page.locator(".cm-editor").count()).toBe(2);
	});

	it("marks the commented line in both panes", async () => {
		expect(await perPane()).toEqual({ markers: [1, 1], highlights: [1, 1] });
	});

	it("clears both when the thread is resolved", async () => {
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["inline-comments"];
			const path = window.app.workspace.getLeavesOfType("markdown")[0].view.file.path;
			const comments = await plugin.storage.getCommentsForFile(path);
			await plugin.setResolved(comments[0], true);
		});
		await page.waitForTimeout(1500);

		expect(await perPane()).toEqual({ markers: [0, 0], highlights: [0, 0] });
	});

	it("brings both back when it is reopened", async () => {
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["inline-comments"];
			const path = window.app.workspace.getLeavesOfType("markdown")[0].view.file.path;
			const comments = await plugin.storage.getCommentsForFile(path);
			await plugin.setResolved(comments[0], false);
		});
		await page.waitForTimeout(1500);

		expect(await perPane()).toEqual({ markers: [1, 1], highlights: [1, 1] });
	});

	it("follows an edit made in one pane in the other", async () => {
		// The anchor moves, and both panes have to re-anchor to the same line.
		await page.evaluate(() => {
			const editor = window.app.workspace.activeEditor!.editor!;
			editor.replaceRange("a new first line\n", { line: 0, ch: 0 }, { line: 0, ch: 0 });
		});
		await page.waitForTimeout(1500);

		const lines = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".cm-editor")).map((editor) => {
				const marked = editor.querySelector(".inline-comment-active-range");
				const line = marked?.closest(".cm-line") ?? null;
				const all = Array.from(editor.querySelectorAll(".cm-line"));
				return line ? all.indexOf(line) : -1;
			}),
		);
		// The commented text moved down a line, in both.
		expect(lines).toEqual([1, 1]);
	});
});
