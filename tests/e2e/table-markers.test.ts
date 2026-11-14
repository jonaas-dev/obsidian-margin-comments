import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { toString(): string; line(n: number): { from: number; to: number } } };
	dispatch(spec: unknown): void;
	lineBlockAt(pos: number): { from: number; top: number; height: number };
	documentTop: number;
}

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
const HEADER_ROW = 3;
const LAST_ROW = 6;

/**
 * #140: a comment on a table cell, in live preview.
 *
 * The table renders as one widget over all of its rows, and the gutter asks
 * about that widget once, by its first line. A comment on any other row had
 * no marker at all, and could not be opened from the margin.
 */
describe("comments inside a rendered table", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Active markers drawn beside the table's rendered block, with their tooltips. */
	const tableMarkers = (): Promise<{ title: string; x: number; y: number }[]> =>
		page.evaluate(
			([header]: [number]) => {
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const block = cm.lineBlockAt(cm.state.doc.line(header).from);
				const top = cm.documentTop + block.top;
				const bottom = top + block.height;
				return Array.from(document.querySelectorAll(".inline-comment-marker-active"))
					.map((m) => ({ m, r: m.getBoundingClientRect() }))
					.filter(
						({ r }) => r.top + r.height / 2 >= top && r.top + r.height / 2 <= bottom,
					)
					.map(({ m, r }) => ({
						title: m.getAttribute("title") ?? "",
						x: r.left + r.width / 2,
						y: r.top + r.height / 2,
					}));
			},
			[HEADER_ROW],
		);

	async function commentOn(word: string): Promise<void> {
		await page.evaluate(async (needle: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf(needle);
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + needle.length,
				`On ${needle}.`,
			);
			// Caret back below the table, so live preview renders it as a widget.
			cm.dispatch({ selection: { anchor: cm.state.doc.toString().length } });
		}, word);
		await page.waitForTimeout(1200);
	}

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
		await page.mouse.move(900, 500);
		await commentOn("cell four");
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("renders the table as one block over its rows, so the tests below can fail", async () => {
		const oneBlock = await page.evaluate(
			([header, last]: [number, number]) => {
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				return (
					cm.lineBlockAt(cm.state.doc.line(last).from).from ===
					cm.lineBlockAt(cm.state.doc.line(header).from).from
				);
			},
			[HEADER_ROW, LAST_ROW],
		);
		expect(oneBlock).toBe(true);
	});

	it("marks the table when a comment sits on a row below its first (#140)", async () => {
		const markers = await tableMarkers();
		expect(markers.map((m) => m.title)).toEqual(["1 comment on this line"]);
	});

	it("counts the threads of every row on that one marker", async () => {
		await commentOn("cell one");
		const markers = await tableMarkers();
		expect(markers.map((m) => m.title)).toEqual(["2 comments on this line"]);
	});

	it("opens every thread in the table from that marker", async () => {
		const [marker] = await tableMarkers();
		await page.mouse.move(marker.x, marker.y);
		await page.waitForTimeout(300);
		await page.mouse.click(marker.x, marker.y);
		await page.waitForTimeout(900);
		const quotes = await page.evaluate(() =>
			Array.from(
				document.querySelectorAll(".inline-comment-popover .inline-comment-quote-text"),
			).map((q) => q.textContent),
		);
		expect(quotes).toEqual(["cell one", "cell four"]);
	});

	/**
	 * #418: Obsidian edits a cell in an editor of its own, nested in the table
	 * widget, and every registered extension reaches it. The gutter mounted
	 * there pushed the cell text right and offered a marker that commented the
	 * whole row.
	 */
	describe("while a cell is being edited", () => {
		/** The left edge of the text "cell two", wherever the table draws it. */
		const cellTextLeft = (): Promise<number | null> =>
			page.evaluate(() => {
				const table = document.querySelector(".workspace-leaf.mod-active .cm-table-widget");
				if (!table) return null;
				const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const at = node.textContent?.indexOf("cell two") ?? -1;
					if (at < 0) continue;
					const range = document.createRange();
					range.setStart(node, at);
					range.setEnd(node, at + 1);
					const rect = range.getBoundingClientRect();
					// Obsidian keeps the rendered cell, hidden, beside the cell's editor.
					if (rect.width > 0) return rect.left;
				}
				return null;
			});

		/** Those that take room on screen: Obsidian mounts the gutter wherever it likes. */
		const nestedGutterParts = (): Promise<number> =>
			page.evaluate(
				() =>
					Array.from(
						document.querySelectorAll(
							".cm-table-widget .inline-comment-gutter, .cm-table-widget .inline-comment-marker, .cm-table-widget .cm-gutters",
						),
					).filter((el) => el.getBoundingClientRect().width > 0).length,
			);

		let before: number | null = null;

		beforeAll(async () => {
			// Close the popover the previous test opened, then enter the cell.
			await page.keyboard.press("Escape");
			await page.waitForTimeout(300);
			before = await cellTextLeft();
			const left = before ?? 0;
			const box = await page.evaluate(() => {
				const cell = Array.from(
					document.querySelectorAll(".workspace-leaf.mod-active .cm-table-widget td"),
				).find((td) => td.textContent?.includes("cell two"));
				const r = cell?.getBoundingClientRect();
				return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
			});
			expect(box, `no cell to click (text at ${left})`).not.toBeNull();
			await page.mouse.click(box.x, box.y);
			await page.waitForTimeout(600);
			// Hover the cell's left edge, where the nested marker used to appear.
			await page.mouse.move(box.x - 40, box.y);
			await page.waitForTimeout(400);
		});

		it("is editing the cell in a nested editor, so the tests below can fail", async () => {
			const nested = await page.evaluate(
				() => document.querySelectorAll(".cm-table-widget .cm-editor").length,
			);
			expect(nested).toBeGreaterThan(0);
			expect(before).not.toBeNull();
		});

		it("shows no comment gutter or marker inside the cell", async () => {
			expect(await nestedGutterParts()).toBe(0);
		});

		it("leaves the cell text where it was", async () => {
			const during = await cellTextLeft();
			expect(during).not.toBeNull();
			expect(Math.abs((during as number) - (before as number))).toBeLessThan(4);
		});

		it("leaves the cell text where it was after leaving the cell", async () => {
			await page.evaluate(() => {
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				cm.dispatch({ selection: { anchor: cm.state.doc.toString().length } });
				(cm as unknown as { focus(): void }).focus();
			});
			await page.mouse.move(900, 500);
			await page.waitForTimeout(600);
			const after = await cellTextLeft();
			expect(after).not.toBeNull();
			expect(Math.abs((after as number) - (before as number))).toBeLessThan(4);
			expect(await nestedGutterParts()).toBe(0);
		});

		it("still marks the table in the note's own gutter (#140)", async () => {
			const markers = await tableMarkers();
			expect(markers.map((m) => m.title)).toEqual(["2 comments on this line"]);
		});
	});
});
