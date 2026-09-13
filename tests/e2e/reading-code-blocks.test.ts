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
	dispatch(spec: unknown): void;
}

const NOTE = "note.md";
const BODY = [
	"A paragraph with a commented phrase in it.",
	"",
	"```js",
	"const answer = 42;",
	"console.log(answer);",
	"```",
	"",
	"The last paragraph.",
].join("\n");

/**
 * #141: a comment inside a fenced code block, in reading mode.
 *
 * The editor highlighted it and reading mode showed nothing at all: no mark in
 * the code and no rule on the block.
 */
describe("reading mode and code blocks", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function setMode(mode: "source" | "preview"): Promise<void> {
		await page.evaluate(async (next: string) => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			await leaf.setViewState({ type: "markdown", state: { file: leaf.view.file.path, mode: next } });
		}, mode);
		await page.waitForTimeout(1200);
	}

	async function commentOn(needle: string, body: string): Promise<void> {
		await page.evaluate(
			async ([text, content]: [string, string]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const at = cm.state.doc.toString().indexOf(text);
				await plugin.routing.createComment(cm, leaf.view.file.path, at, at + text.length, content);
			},
			[needle, body],
		);
		await page.waitForTimeout(1000);
	}

	const codeBlock = (): Promise<{ rendered: boolean; ruled: boolean }> =>
		page.evaluate(() => {
			const pre = document.querySelector(".markdown-reading-view pre");
			const section = pre?.closest(".el-pre");
			return {
				rendered: pre?.querySelector("code") !== null && pre?.querySelector("code") !== undefined,
				ruled: section?.classList.contains("inline-comment-reading-block") ?? false,
			};
		});

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

		await commentOn("answer = 42", "On the code.");
		await commentOn("a commented phrase", "On the phrase.");
		await setMode("preview");
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("renders the code block, so the assertions below have something to check", async () => {
		expect((await codeBlock()).rendered).toBe(true);
	});

	it("marks a code block that carries an open comment (#141)", async () => {
		expect((await codeBlock()).ruled).toBe(true);
	});

	it("still marks the words of a comment in an ordinary paragraph", async () => {
		const marks = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".markdown-reading-view .inline-comment-reading-mark")).map(
				(m) => m.textContent,
			),
		);
		expect(marks).toContain("a commented phrase");
	});

	it("drops the code block's mark when its thread is resolved", async () => {
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile("note.md");
			const onCode = comments.find((c: { content: string }) => c.content === "On the code.");
			await plugin.setResolved(onCode, true);
		});
		await page.waitForTimeout(1500);
		expect((await codeBlock()).ruled).toBe(false);
	});
});
