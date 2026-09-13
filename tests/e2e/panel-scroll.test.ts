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
const OTHER = "other.md";
const COMMENTS = 14;
const SCROLLED = 250;
const note = (name: string): string =>
	Array.from({ length: 40 }, (_, i) => `${name} line ${i + 1} has a word to comment on.`).join("\n");

/**
 * #162: every repaint of the panel sent its list back to the top, because the
 * scroller is emptied and rebuilt.
 *
 * Both lists are long enough to scroll, and that is checked: with a list that
 * cannot scroll, a position of 0 before and after passes against any build, and
 * so would a fix that kept the position across notes.
 */
describe("the panel's scroll position", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const openNote = (path: string): Promise<void> =>
		page.evaluate(async (p: string) => {
			const file = window.app.vault.getAbstractFileByPath(p);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, path);

	const commentEveryLine = (name: string): Promise<void> =>
		page.evaluate(
			async ([label, count]: [string, number]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				for (let i = 1; i <= count; i++) {
					const at = cm.state.doc.toString().indexOf(`${label} line ${i} has`);
					await plugin.routing.createComment(
						cm,
						leaf.view.file.path,
						at,
						at + label.length,
						`Comment ${i}, long enough to wrap onto a second line in a sidebar card.`,
					);
				}
			},
			[name, COMMENTS],
		);

	const panelScroll = (): Promise<{ top: number; room: number }> =>
		page.evaluate(() => {
			const panel = document.querySelector(".inline-comment-panel") as HTMLElement;
			return { top: panel.scrollTop, room: panel.scrollHeight - panel.clientHeight };
		});

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: note("Note"), [OTHER]: note("Other") });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await openNote(OTHER);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);
		await commentEveryLine("Other");
		await openNote(NOTE);
		await page.waitForTimeout(500);
		await commentEveryLine("Note");
		await page.evaluate(() =>
			window.app.commands.executeCommandById("margin-comments:toggle-comments-panel"),
		);
		await page.waitForFunction(
			(count: number) => document.querySelectorAll(".inline-comment-panel .inline-comment-card").length >= count,
			COMMENTS,
			{ timeout: 10000 },
		);
		await page.waitForTimeout(800);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("keeps its place when the same list repaints (#162)", async () => {
		await page.evaluate((to: number) => {
			(document.querySelector(".inline-comment-panel") as HTMLElement).scrollTop = to;
		}, SCROLLED);
		await page.waitForTimeout(200);
		const before = await panelScroll();
		// Guard: the list really scrolled that far.
		expect(before.room).toBeGreaterThan(SCROLLED);
		expect(before.top).toBeGreaterThan(SCROLLED - 2);

		await page.evaluate(() => window.app.plugins.plugins["margin-comments"].refresh());
		await page.waitForTimeout(500);
		expect(Math.abs((await panelScroll()).top - before.top)).toBeLessThanOrEqual(1);
	});

	it("starts another note's list from the top", async () => {
		await page.evaluate((to: number) => {
			(document.querySelector(".inline-comment-panel") as HTMLElement).scrollTop = to;
		}, SCROLLED);
		await openNote(OTHER);
		await page.waitForTimeout(900);
		const after = await panelScroll();
		// Guard: this list could have held the old position.
		expect(after.room).toBeGreaterThan(SCROLLED);
		expect(after.top).toBe(0);
	});
});
