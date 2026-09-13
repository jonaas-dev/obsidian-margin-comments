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
const BODY = ["A list:", "", "1. Numbered one", "2. Numbered two", "", "The end."].join("\n");

/**
 * #175: reading mode searched a block for a comment's words and took the first
 * match, so a comment on "Numbered" in the second item was painted in the first.
 *
 * Both items carry a comment, so a mark in the wrong item cannot pass as the
 * right one.
 */
describe("marking repeated words in reading mode", () => {
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
			for (const [item, content] of [
				["Numbered one", "On the first item."],
				["Numbered two", "On the second item."],
			]) {
				const at = doc.indexOf(item);
				await plugin.routing.createComment(cm, leaf.view.file.path, at, at + "Numbered".length, content);
			}
			await leaf.setViewState({ type: "markdown", state: { file: leaf.view.file.path, mode: "preview" } });
		});
		await page.waitForSelector(".markdown-reading-view .inline-comment-reading-mark", { timeout: 10000 });
		await page.waitForTimeout(800);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("marks each appearance where its comment is anchored (#175)", async () => {
		const items = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments: { id: string; content: string }[] = await plugin.storage.getCommentsForFile("note.md");
			const contentOf = new Map(comments.map((c) => [c.id, c.content]));
			return Array.from(document.querySelectorAll(".markdown-reading-view li")).map((li) => ({
				item: (li.textContent ?? "").trim(),
				marked: Array.from(li.querySelectorAll(".inline-comment-reading-mark")).map((mark) =>
					contentOf.get((mark as HTMLElement).dataset.threadId ?? ""),
				),
			}));
		});
		expect(items).toEqual([
			{ item: "Numbered one", marked: ["On the first item."] },
			{ item: "Numbered two", marked: ["On the second item."] },
		]);
	});
});
