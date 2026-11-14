import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { toString(): string; length: number } };
	dispatch(spec: unknown): void;
}

const NOTE = "note.md";
const BODY = [
	"A paragraph above the table.",
	"",
	// Padded as Obsidian pads a table it edits, so entering a cell rewrites nothing.
	"| Name  | Status  |",
	"| ----- | ------- |",
	"| Alpha | done    |",
	"| Beta  | pending |",
	"",
	"> [!note] A callout title",
	"> Callout body sentence that someone comments on.",
	"",
	"A paragraph below with a closing word.",
].join("\n");

/**
 * #419: Obsidian draws a live-preview table or callout as one block widget, so
 * CodeMirror's mark and line decorations over it reach no DOM and a comment
 * inside one was not marked at all while the block was rendered.
 */
describe("comment highlights inside rendered tables and callouts", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Comment `needle`, or its whole line when `line` is set, then park the caret. */
	async function commentOn(needle: string, line = false): Promise<string> {
		const id = await page.evaluate(
			async ([needle, line]: [string, boolean]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const at = cm.state.doc.toString().indexOf(needle);
				const before = await plugin.storage.getCommentsForFile(leaf.view.file.path);
				await plugin.routing.createComment(
					cm,
					leaf.view.file.path,
					at,
					line ? at : at + needle.length,
					`On ${needle}.`,
				);
				const after = await plugin.storage.getCommentsForFile(leaf.view.file.path);
				return after.find(
					(c: { id: string }) => !before.some((b: { id: string }) => b.id === c.id),
				)?.id;
			},
			[needle, line],
		);
		await parkCaret();
		return id;
	}

	/** Caret on the last line, so live preview renders the table and callout. */
	async function parkCaret(): Promise<void> {
		await page.evaluate(() => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		});
		await page.waitForTimeout(1000);
	}

	/** What each rendered widget carries, read from the DOM. */
	const painted = (): Promise<{
		table: { text: string; id: string }[];
		callout: { text: string; id: string }[];
		tableBlock: string[];
		widgets: number;
	}> =>
		page.evaluate(() => {
			const root = document.querySelector(".workspace-leaf.mod-active .cm-content");
			const marks = (sel: string) =>
				Array.from(root?.querySelectorAll(`${sel} .inline-comment-reading-mark`) ?? []).map(
					(m) => ({
						text: m.textContent ?? "",
						id: (m as HTMLElement).dataset.threadId ?? "",
					}),
				);
			const table = root?.querySelector(".cm-table-widget");
			const block = table?.closest(".inline-comment-reading-block") ?? table;
			return {
				table: marks(".cm-table-widget"),
				callout: marks(".cm-callout"),
				tableBlock: block?.classList.contains("inline-comment-reading-block")
					? ((block as HTMLElement).dataset.threadIds ?? "").split(" ")
					: [],
				widgets: root?.querySelectorAll(".cm-table-widget, .cm-callout").length ?? 0,
			};
		});

	let cellId = "";
	let calloutId = "";

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
		await page.mouse.move(900, 500);
		cellId = await commentOn("pending");
		calloutId = await commentOn("Callout body");
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("renders the table and the callout as widgets, so the tests below can fail", async () => {
		expect((await painted()).widgets).toBe(2);
	});

	it("marks the commented word in a table cell", async () => {
		expect((await painted()).table).toEqual([{ text: "pending", id: cellId }]);
	});

	it("leaves the note's text alone while painting inside its widgets", async () => {
		const doc = await page.evaluate(() =>
			window.app.workspace.activeEditor?.editor?.getValue(),
		);
		expect(doc).toBe(BODY);
	});

	it("keeps its marks out of a cell being edited, and the cell's text whole", async () => {
		const box = await page.evaluate(() => {
			const cell = Array.from(
				document.querySelectorAll(".workspace-leaf.mod-active .cm-table-widget td"),
			).find((td) => td.textContent?.includes("pending"));
			const r = cell?.getBoundingClientRect();
			return r ? { x: r.right - 6, y: r.top + r.height / 2 } : null;
		});
		expect(box).not.toBeNull();
		await page.mouse.click(box.x, box.y);
		await page.waitForTimeout(800);
		const cell = await page.evaluate(() => {
			const editor = document.querySelector(".cm-table-widget .cm-editor");
			return {
				editing: editor !== null,
				marksInEditor:
					editor?.querySelectorAll(".inline-comment-reading-mark").length ?? -1,
				text: editor?.querySelector(".cm-content")?.textContent ?? "",
				doc: window.app.workspace.activeEditor?.editor?.getValue(),
			};
		});
		expect(cell).toEqual({ editing: true, marksInEditor: 0, text: "pending", doc: BODY });
		await parkCaret();
		await page.mouse.move(900, 500);
		expect((await painted()).table).toEqual([{ text: "pending", id: cellId }]);
	});

	it("marks the commented words in a callout body", async () => {
		expect((await painted()).callout).toEqual([{ text: "Callout body", id: calloutId }]);
	});

	it("repaints once after an edit elsewhere, never twice", async () => {
		await page.evaluate(() => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			cm.dispatch({ changes: { from: 0, insert: "Edited. " } });
		});
		await parkCaret();
		// And again through a full refresh, which re-renders through the effect.
		await page.evaluate(() => window.app.plugins.plugins["margin-comments"].refresh());
		await page.waitForTimeout(800);
		const seen = await painted();
		expect(seen.table).toEqual([{ text: "pending", id: cellId }]);
		expect(seen.callout).toEqual([{ text: "Callout body", id: calloutId }]);
	});

	it("marks the table for a whole-line comment on one of its rows", async () => {
		const rowId = await commentOn("| Alpha", true);
		expect((await painted()).tableBlock).toEqual([rowId]);
	});

	it("does not paint a resolved thread", async () => {
		await page.evaluate(async (id: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const comments = await plugin.storage.getCommentsForFile(leaf.view.file.path);
			await plugin.setResolved(
				comments.find((c: { id: string }) => c.id === id),
				true,
			);
		}, calloutId);
		await page.waitForTimeout(1000);
		expect((await painted()).callout).toEqual([]);
	});
});
