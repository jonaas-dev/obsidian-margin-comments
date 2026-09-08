import { describe, it, expect, beforeAll, afterAll } from "vitest";
interface EditorViewLike {
	state: { doc: { toString(): string } };
	dispatch(spec: unknown): void;
}

import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = [
	"The first paragraph carries a commented phrase in the middle of it.",
	"",
	"A paragraph with **bold text** the renderer eats.",
	"",
	"- a plain list item",
	"- another list item",
].join("\n");

/**
 * #34: reading mode gets the highlights.
 *
 * CodeMirror extensions do not apply here, so the gutter and the line
 * decorations are simply absent — this suite is about what the Markdown
 * post-processor puts in the rendered output instead.
 */
describe("reading mode", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function setMode(mode: "source" | "preview"): Promise<void> {
		await page.evaluate(async (next: string) => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			await leaf.setViewState({
				type: "markdown",
				state: { file: leaf.view.file.path, mode: next },
			});
		}, mode);
		await page.waitForTimeout(1200);
	}

	/**
	 * Comment a range of the note through the plugin's own path.
	 *
	 * The editor API rather than the gutter and the composer: the selection is
	 * the point here, and the harness cannot hold focus in the editor to make
	 * one by hand.
	 */
	async function commentOn(needle: string, body: string): Promise<void> {
		await page.evaluate(
			async ([text, content]: [string, string]) => {
				const plugin = window.app.plugins.plugins["inline-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const doc = cm.state.doc.toString();
				const at = doc.indexOf(text);
				cm.dispatch({ selection: { anchor: at, head: at + text.length } });
				await plugin.createComment(cm, leaf.view.file.path, at, at + text.length, content);
			},
			[needle, body],
		);
		await page.waitForTimeout(1200);
	}

	const marks = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".markdown-reading-view .inline-comment-reading-mark"))
				.map((m) => m.textContent ?? ""),
		);

	const markedBlocks = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".markdown-reading-view .inline-comment-reading-block"))
				.map((b) => (b.textContent ?? "").slice(0, 30)),
		);

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
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("marks the commented words in the rendered output", async () => {
		await commentOn("a commented phrase", "a comment on the phrase");
		await setMode("preview");
		await page.waitForSelector(".markdown-reading-view", { timeout: 10000 });

		expect(await marks()).toEqual(["a commented phrase"]);
	});

	it("leaves the rest of the note alone", async () => {
		// The mark has to be a range, not the paragraph: a whole-paragraph tint
		// would say the comment is about all of it.
		const paragraph = await page.evaluate(
			() =>
				document.querySelector(".markdown-reading-view .inline-comment-reading-mark")!
					.parentElement!.textContent,
		);
		expect(paragraph).toContain("The first paragraph carries");
		expect(await markedBlocks()).toEqual([]);
	});

	it("shows a comment added while editing, which a cached render would not", async () => {
		// Obsidian invalidates its cached reading render when the *note* changes.
		// Comments live outside the note, so nothing invalidates it for them: the
		// first version of this only re-rendered leaves already showing preview,
		// and switching to reading mode after commenting showed the note without
		// the new mark. Instrumented, the post-processor was not called once.
		await setMode("source");
		await commentOn("in the middle of it", "a second comment on the first paragraph");
		await setMode("preview");

		expect((await marks()).sort()).toEqual(["a commented phrase", "in the middle of it"]);
	});

	it("marks a list item without marking the whole list", async () => {
		await setMode("source");
		await commentOn("another list item", "a comment on the second item");
		await setMode("preview");

		const inside = await page.evaluate(() => {
			const mark = Array.from(
				document.querySelectorAll(".markdown-reading-view .inline-comment-reading-mark"),
			).find((m) => m.textContent === "another list item")!;
			return { tag: mark.closest("li")?.tagName ?? null, list: mark.closest("ul") !== null };
		});
		expect(inside).toEqual({ tag: "LI", list: true });
		// The list itself is untouched: the fallback would have swallowed both items.
		expect(await markedBlocks()).toEqual([]);
	});

	it("marks the block when the comment was made on markup the renderer ate", async () => {
		await setMode("source");
		await commentOn("**bold text**", "a comment on the markup");
		await setMode("preview");

		// "**bold text**" is not in the rendered text at all, so there is no range
		// to mark and the block says so instead of guessing.
		expect(await marks()).not.toContain("**bold text**");
		expect((await markedBlocks()).join(" ")).toContain("A paragraph with bold text");
	});

	it("drops the mark when the thread is resolved, without leaving reading mode", async () => {
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		const before = (await marks()).length;

		await page.locator('[aria-label="Resolve"]').first().click();
		await page.waitForTimeout(1500);

		expect((await marks()).length).toBe(before - 1);
	});

	it("has no gutter and no line decorations here, which is the documented gap", async () => {
		// Not a limitation this suite works around: CodeMirror extensions do not
		// run in reading mode, and the README says so.
		expect(await page.locator(".markdown-reading-view .inline-comment-marker").count()).toBe(0);
		expect(
			await page.locator(".markdown-reading-view .inline-comment-active-line").count(),
		).toBe(0);
	});
});
