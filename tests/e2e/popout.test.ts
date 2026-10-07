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

/**
 * A note open in a popout window (#236).
 *
 * A popout is a second window with its own document. Anything the plugin builds on
 * the main window's `document` is drawn there instead, out of sight of a reader
 * working in the popout — which is what happened to the composer and the popover.
 */
describe("a note in a popout window", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let main: any;
	let popout: any;

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: ["first line", "second line", "third line"].join("\n") });
		session = await launchObsidian(vault.path);
		main = session.page;
		await waitForWorkspace(main);
		await enablePlugin(main, "margin-comments");
		await dismissModals(main);

		const before = main.context().pages().length;
		// Not awaited inside the page: the popout's openFile does not settle until the
		// new window has painted, and page.evaluate has no timeout of its own.
		await main.evaluate((note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			const leaf = window.app.workspace.openPopoutLeaf();
			void leaf.openFile(file, { state: { mode: "source" } });
		}, NOTE);
		for (let i = 0; i < 40 && main.context().pages().length === before; i++) {
			await main.waitForTimeout(250);
		}
		popout = main
			.context()
			.pages()
			.find((p: any) => p !== main && !p.url().startsWith("devtools://"));
		await popout.waitForSelector(".cm-editor", { timeout: 15000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	async function gutterPoint(lineIndex: number): Promise<{ x: number; y: number }> {
		const gutters = await popout.locator(".cm-gutters").boundingBox();
		const line = await popout.locator(".cm-line").nth(lineIndex).boundingBox();
		return { x: gutters.x + gutters.width / 2, y: line.y + line.height / 2 };
	}

	const count = async (page: any, selector: string): Promise<number> =>
		page.locator(selector).count();

	it("opens the composer in the popout, where the gutter was clicked", async () => {
		const point = await gutterPoint(1);
		await popout.mouse.move(point.x, point.y);
		await popout.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await popout.mouse.click(point.x, point.y);
		await popout.waitForTimeout(800);

		expect(await count(popout, ".inline-comment-composer")).toBe(1);
		expect(await count(main, ".inline-comment-composer")).toBe(0);

		await popout.locator(".inline-comment-composer-input").fill("from the popout");
		await popout.locator(".inline-comment-composer .mod-cta").click();
		await popout.waitForTimeout(1500);
	});

	it("opens the popover in the popout when that line's marker is clicked", async () => {
		const point = await gutterPoint(1);
		await popout.mouse.move(point.x, point.y);
		await popout.waitForTimeout(300);
		await popout.mouse.click(point.x, point.y);
		await popout.waitForTimeout(800);

		expect(await count(popout, ".inline-comment-popover")).toBe(1);
		expect(await count(main, ".inline-comment-popover")).toBe(0);
	});

	it("closes the popover on a click elsewhere in the popout", async () => {
		// Open to begin with, or a popover drawn in the other window passes this vacuously.
		expect(await count(popout, ".inline-comment-popover")).toBe(1);

		const editor = await popout.locator(".cm-content").boundingBox();
		await popout.mouse.click(editor.x + editor.width - 20, editor.y + editor.height - 20);
		await popout.waitForTimeout(600);

		expect(await count(popout, ".inline-comment-popover")).toBe(0);
		expect(await count(main, ".inline-comment-popover")).toBe(0);
	});

	it("opens a thread from a reading-mode mark in the popout", async () => {
		await main.evaluate(async () => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((candidate: any) => candidate.view.containerEl.ownerDocument !== document);
			const state = leaf.getViewState();
			await leaf.setViewState({ ...state, state: { ...state.state, mode: "preview" } });
		});
		const mark = popout
			.locator(".inline-comment-reading-block, .inline-comment-reading-mark")
			.first();
		await mark.waitFor({ timeout: 10000 });

		await mark.click();
		await popout.waitForTimeout(800);

		expect(await count(popout, ".inline-comment-popover")).toBe(1);
		expect(await count(main, ".inline-comment-popover")).toBe(0);
	});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
