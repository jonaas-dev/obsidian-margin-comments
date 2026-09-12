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

	/**
	 * Open an edit box and wait until it is really there.
	 *
	 * The click is retried once on purpose. A repaint left in flight by the
	 * previous step replaces the card between hovering it and pressing its
	 * button, so the press lands on a detached node and nothing opens — which
	 * surfaces as a 30-second wait for the textarea, not as a failed click.
	 */
	async function openEditor(label = "Edit comment"): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			await page.locator(".inline-comment-card").first().hover();
			await page.waitForTimeout(400);
			await page.locator(`[aria-label="${label}"]`).first().click({ force: true });
			try {
				await page.waitForSelector(".inline-comment-editor-input", { timeout: 3000 });
				return;
			} catch {
				/* the card was replaced under us; try once more */
			}
		}
		throw new Error(`the ${label} box never opened`);
	}

	/** Every stored comment body, read off disk through the plugin. */
	const storedBodies = (): Promise<string[]> =>
		page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["inline-comments"];
			const comments = await plugin.storage.getCommentsForFile("note.md");
			return comments.map((c: { content: string }) => c.content);
		});

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
		await openEditor();

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

	it("commits the change when the reader presses in the note (#114)", async () => {
		// Measured before: the box vanished and the draft went with it, because
		// the panel repainted and took the box along. Asserted on what is stored,
		// because the bug is that the text was lost — not that a box disappeared.
		await openEditor();
		const input = page.locator(".inline-comment-editor-input").first();
		await input.click();
		await input.fill("committed by pressing in the note");

		await page.locator(".cm-line").first().click();
		await page.waitForTimeout(1400);

		expect(await storedBodies()).toContain("committed by pressing in the note");
		expect(await page.locator(".inline-comment-editor").count()).toBe(0);
	});

	it("throws the change away on Cancel (#114)", async () => {
		// The explicit way out has to keep working, or committing on an outside
		// press would leave no way to abandon an edit.
		//
		// Cancel rather than Escape: the harness cannot hold focus in a textarea,
		// so a keydown never reaches it — the limitation AGENTS.md records. Both
		// take the same path (`finish` without saving), and the Escape *decision*
		// is covered by keyIntent's unit tests.
		const before = await storedBodies();

		await openEditor();
		const input = page.locator(".inline-comment-editor-input").first();
		await input.click();
		await input.fill("this must never be stored");
		await page.locator('[aria-label="Cancel edit"]').first().click();
		await page.waitForTimeout(1200);

		expect(await storedBodies()).toEqual(before);
		expect(await page.locator(".inline-comment-editor").count()).toBe(0);
	});

	it("closes when the reader presses elsewhere in the panel (#114)", async () => {
		// The original report: a press elsewhere in the panel used to leave the
		// box open indefinitely.
		await openEditor();
		expect(await page.locator(".inline-comment-editor").count()).toBe(1);

		await page.locator(".inline-comment-panel-title").click({ force: true });
		await page.waitForTimeout(900);
		expect(await page.locator(".inline-comment-editor").count()).toBe(0);
	});

	it("stays open while the reader is working inside it (#114)", async () => {
		// Committing on any press at all would close the box the moment someone
		// clicked into their own text to fix a typo.
		await openEditor();

		const input = page.locator(".inline-comment-editor-input").first();
		await input.click();
		await input.fill("still being written");
		await input.click();
		await page.waitForTimeout(500);

		expect(await page.locator(".inline-comment-editor").count()).toBe(1);
		await page.locator('[aria-label="Cancel edit"]').first().click();
		await page.waitForTimeout(800);
	});

	it("puts a reply's editor inside that reply, where it always was", async () => {
		await openEditor("Edit reply");

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
