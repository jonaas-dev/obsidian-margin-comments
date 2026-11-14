import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = [
	"A paragraph above the table.",
	"",
	"| Column A | Column B |",
	"|----------|----------|",
	"| cell one | cell two |",
	"| cell three | cell four |",
	"",
	"A paragraph below the table.",
].join("\n");

/**
 * #420: inside a rendered table CodeMirror has no box for a position, so
 * `coordsAtPos` returned the widget's edge and the composer opened pinned to
 * the window's right edge instead of beside the selected word.
 */
describe("composer anchored to a selection inside a rendered table", () => {
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

	it("opens the composer beside the word selected in a table cell", async () => {
		await page.waitForSelector(".cm-table-widget td", { timeout: 30000 });
		// Aim at the end of the cell text: a nested gutter marker covers its start.
		const pt = await page.evaluate(() => {
			const td = Array.from(document.querySelectorAll(".cm-table-widget td")).find((e) =>
				(e.textContent ?? "").includes("cell three"),
			)!;
			const text = document.createTreeWalker(td, NodeFilter.SHOW_TEXT).nextNode()!;
			const range = document.createRange();
			range.setStart(text, 7);
			range.setEnd(text, 9);
			const r = range.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		});
		await page.mouse.click(pt.x, pt.y);
		await page.waitForTimeout(600);
		await page.mouse.dblclick(pt.x, pt.y);
		await page.waitForTimeout(400);

		const word = await page.evaluate(() => {
			const sel = window.getSelection()!;
			if (sel.isCollapsed) return null;
			const r = sel.getRangeAt(0).getBoundingClientRect();
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		});
		expect(word).not.toBeNull();

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:add-comment");
		});
		await page.waitForSelector(".inline-comment-composer", { timeout: 10000 });
		await page.waitForTimeout(500);
		const box = await page.evaluate(() => {
			const r = document.querySelector(".inline-comment-composer")!.getBoundingClientRect();
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		});

		const slack = 60;
		expect(box.left, "composer overlaps the word horizontally").toBeLessThanOrEqual(
			word!.right + slack,
		);
		expect(box.right).toBeGreaterThanOrEqual(word!.left - slack);
		const gap = Math.max(box.top - word!.bottom, word!.top - box.bottom);
		expect(gap, "composer is vertically next to the word").toBeLessThanOrEqual(slack);
	});
});
