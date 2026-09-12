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
 * #99: the edit box opens where the comment is.
 *
 * `startEditing` appended to its parent, and a root comment's parent is the
 * whole card — so the box landed under every reply and under the reply field.
 */
describe("editing a comment in place", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** The card's children, in order, by their first class. */
	const cardShape = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from((document.querySelector(".inline-comment-card") as HTMLElement).children).map(
				(el) => el.className.split(" ")[0],
			),
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

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["inline-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.createComment(cm, leaf.view.file.path, at, at + 4, "The root comment.");
		});
		await page.waitForTimeout(1200);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });

		// Two replies, so "at the end" and "in place" are far apart.
		for (const text of ["First reply.", "Second reply."]) {
			await page.locator(".inline-comment-card").first().hover();
			await page.locator(".inline-comment-replybox-input").first().click();
			await page.locator(".inline-comment-replybox-input").first().fill(text);
			await page.locator(".inline-comment-send").first().click();
			await page.waitForTimeout(1400);
		}
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("has a card with replies after it, so the two positions differ", async () => {
		// Without this the assertion below could pass on a card with nothing
		// after the body, where every position is the same position.
		const shape = await cardShape();
		expect(shape.filter((c) => c === "inline-comment-reply")).toHaveLength(2);
	});

	it("opens the editor right after the comment it edits, not at the end", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Edit comment"]').first().click();
		await page.waitForTimeout(600);

		const shape = await cardShape();
		const editor = shape.indexOf("inline-comment-editor");
		const firstReply = shape.indexOf("inline-comment-reply");
		const replybox = shape.indexOf("inline-comment-replybox");

		expect(editor).toBeGreaterThan(-1);
		// Before the replies and before the reply field — measured, it used to be
		// index 6 of 7, after both.
		expect(editor).toBeLessThan(firstReply);
		expect(editor).toBeLessThan(replybox);
	});

	it("still saves the edit from there", async () => {
		// The move must not orphan the buttons from the textarea they belong to.
		const input = page.locator(".inline-comment-editor-input").first();
        await input.click();
		await input.fill("The root comment, edited in place.");
		await page.locator('[aria-label="Save changes"]').first().click();
		await page.waitForTimeout(1400);

		const bodies = await page.locator(".inline-comment-body").allInnerTexts();
		expect(bodies[0]).toContain("edited in place");
	});

	it("puts a reply's editor inside that reply, where it always was", async () => {
		await page.locator(".inline-comment-reply").first().hover();
		await page.locator('.inline-comment-reply [aria-label="Edit reply"]').first().click();
		await page.waitForTimeout(600);

		const where = await page.evaluate(() => {
			const editor = document.querySelector(".inline-comment-editor") as HTMLElement;
			return {
				insideAReply: editor.closest(".inline-comment-reply") !== null,
				directChildOfCard: editor.parentElement?.classList.contains("inline-comment-card") ?? false,
			};
		});
		expect(where).toEqual({ insideAReply: true, directChildOfCard: false });
	});
});
