import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOTE = "note.md";
const BODY = Array.from({ length: 40 }, (_, i) => `line ${i} of the note under test`).join("\n");

/**
 * Typing must not drag the plugin behind it.
 *
 * Every keystroke used to run the whole redraw: re-anchor every comment for the
 * gutter, again for the highlights, then repaint every card in the panel with a
 * Markdown render each. This asserts the shape of the fix rather than a
 * stopwatch reading — the panel must not repaint *during* a burst, and must
 * repaint once it ends, because a debounce that never fires would also be still.
 */
describe("typing latency", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;

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

		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page
			.locator(".inline-comment-composer-input")
			.fill("a comment to keep the panel busy");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-card", { timeout: 10000 });
		await page.waitForTimeout(500);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	/**
	 * Watch the panel for repaints.
	 *
	 * Counted by the disappearance of the card list, not by mutation records:
	 * a paint empties the container child by child, so records-with-removals
	 * counts the size of the panel rather than the number of redraws.
	 */
	async function watchPanel(): Promise<void> {
		await page.evaluate(() => {
			const panel = document.querySelector(".inline-comment-panel");
			if (!panel) throw new Error("no panel to watch");
			(window as any).__repaints = 0;
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of Array.from(record.removedNodes)) {
						if (
							node instanceof Element &&
							node.classList.contains("inline-comment-list")
						) {
							(window as any).__repaints++;
						}
					}
				}
			});
			observer.observe(panel, { childList: true });
			(window as any).__observer = observer;
		});
	}

	const repaints = (): Promise<number> =>
		page.evaluate(() => (window as any).__repaints as number);

	/**
	 * A run of edits, one every `gapMs`.
	 *
	 * Through the editor API rather than synthetic key events: the harness cannot
	 * hold focus in the editor, so keyboard.type reaches nothing. What is under
	 * test is the debounce on Obsidian's editor-change event, and the API path
	 * fires it exactly as a keypress does.
	 */
	const burst = (count: number, gapMs: number): Promise<void> =>
		page.evaluate(
			async ([times, gap]: [number, number]) => {
				const leaf = window.app.workspace
					.getLeavesOfType("markdown")
					.find((l: any) => l.view.editor);
				const editor = leaf.view.editor;
				for (let i = 0; i < times; i++) {
					editor.replaceRange("x", { line: 0, ch: 0 });
					await new Promise((resolve) => setTimeout(resolve, gap));
				}
			},
			[count, gapMs],
		);

	const docText = (): Promise<string> =>
		page.evaluate(() => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: any) => l.view.editor);
			return leaf.view.editor.getValue() as string;
		});

	it("does not repaint the panel while a burst of typing is in flight", async () => {
		// Before the observer: clicking into the editor makes it the active leaf,
		// and active-leaf-change redraws immediately and deliberately. That is a
		// single act by a person, not a burst, so it is not what this measures.
		await page.locator(".cm-content").first().click();
		await page.waitForTimeout(800);
		await watchPanel();
		// Twenty keystrokes, each well inside the debounce window, so the pass is
		// pushed forward by every one of them and never runs mid-burst.
		const before = await docText();
		await burst(20, 40);

		// Proof the edits landed. The first version of this test used
		// page.keyboard.type, and the harness never got focus into the editor —
		// so nothing was typed, nothing repainted, and the assertion below was
		// perfect. The document length is the only thing that tells them apart.
		const after = await docText();
		expect(after.length).toBe(before.length + 20);

		expect(await repaints()).toBe(0);
	});

	it("repaints once the typing stops, so the debounce delays rather than drops", async () => {
		// Without this the test above would pass against a plugin that stopped
		// reacting to edits altogether, which is not the same thing at all.
		await page.waitForTimeout(1200);
		expect(await repaints()).toBeGreaterThan(0);

		const settled = await repaints();
		await page.waitForTimeout(800);
		// And it stops: one pass for the burst, not a queue of them draining.
		expect(await repaints()).toBe(settled);
	});

	it("still shows the comment after all that typing", async () => {
		// The cheapest way to pass the two tests above is to break the redraw.
		expect(await page.locator(".inline-comment-card").count()).toBe(1);
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"a comment to keep the panel busy",
		);
	});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
