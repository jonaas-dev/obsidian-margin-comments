import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["alpha line", "beta line", "gamma line"].join("\n");

/**
 * #68: the gutter marker tells one thread from several.
 *
 * The whole point is that it does so *without opening the panel*, so every
 * assertion reads the editor's gutter rather than the panel's cards.
 *
 * The several-threads state is reached by commenting separate lines and then
 * joining them. Editing a note into that shape is the case the count exists for,
 * and it exercises the re-anchoring on the way; #75 has since made a line's
 * second thread reachable directly, which `second-thread.test.ts` covers.
 */
describe("comment count in the gutter", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Comment a line through the UI, the way a person would. */
	async function commentOnLine(index: number, body: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(index).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		// Wait for a marker on *this* line: once another line carries a comment
		// its marker is permanently visible, so waiting for any marker resolves
		// instantly and the click lands before the hover has registered.
		await page.waitForFunction(
			(centre: number) =>
				Array.from(document.querySelectorAll(".inline-comment-marker")).some((m) => {
					const r = m.getBoundingClientRect();
					return Math.abs(r.top + r.height / 2 - centre) < 12;
				}),
			y,
			{ timeout: 5000 },
		);
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(body);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1200);
	}

	/**
	 * Join the line after `index` onto it, through the editor API.
	 *
	 * The API rather than keystrokes: the harness cannot hold focus in the
	 * editor, so typing writes nothing at all — and it is `editor-change` that
	 * this exercises anyway.
	 */
	async function joinNextLineOnto(index: number): Promise<void> {
		await page.evaluate((line: number) => {
			const editor = window.app.workspace.activeEditor!.editor!;
			editor.replaceRange(
				" ",
				{ line, ch: editor.getLine(line).length },
				{ line: line + 1, ch: 0 },
			);
		}, index);
		// Past the 300ms debounce on editor-change.
		await page.waitForTimeout(1200);
	}

	async function setSetting(key: string, value: unknown): Promise<void> {
		await page.evaluate(
			async ([name, next]: [string, unknown]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				(plugin.settings as Record<string, unknown>)[name] = next;
				window.app.workspace.trigger("editor-change");
			},
			[key, value],
		);
		await page.waitForTimeout(1000);
	}

	/** The badge text on each commented line, in document order. */
	const badges = (): Promise<string[]> =>
		page.evaluate(() =>
			(
				Array.from(
					document.querySelectorAll(".inline-comment-marker-active"),
				) as HTMLElement[]
			)
				.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
				.map((m) => m.querySelector(".inline-comment-marker-count")?.textContent ?? ""),
		);

	/**
	 * The tooltip on each marker, in document order.
	 *
	 * A title rather than an aria-label: CodeMirror marks the whole gutter
	 * `aria-hidden`, so nothing in it reaches a screen reader whatever role it
	 * carries (#84). This is what a pointer user gets.
	 */
	const labels = (): Promise<string[]> =>
		page.evaluate(() =>
			(
				Array.from(
					document.querySelectorAll(".inline-comment-marker-active"),
				) as HTMLElement[]
			)
				.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
				.map((m) => m.getAttribute("title") ?? ""),
		);

	/**
	 * Where the note's text starts, which is what a growing gutter pushes around.
	 * Read from the line box rather than the gutter's width: the criterion is
	 * about the text moving, and that is what a reader sees.
	 */
	const textLeft = (): Promise<number> =>
		page.evaluate(
			() => +document.querySelector(".cm-line")!.getBoundingClientRect().left.toFixed(1),
		);

	const gutterWidth = (): Promise<number> =>
		page.evaluate(
			() => +document.querySelector(".cm-gutters")!.getBoundingClientRect().width.toFixed(1),
		);

	/**
	 * What the widest badge does to the gutter column and the note's text.
	 *
	 * Forced to two glyphs rather than grown to ten threads: "9+" is the widest
	 * the badge ever gets, and it is where a marker sized by its contents pushes
	 * the gutter out. At one glyph it does not — the gutter's minimum width
	 * happens to absorb it — which is why an earlier version of this measurement
	 * passed against exactly the layout it was meant to reject.
	 */
	const atWidestBadge = (): Promise<{ gutterWidth: number; textLeft: number }> =>
		page.evaluate(() => {
			const badge = document.querySelector(".inline-comment-marker-count") as HTMLElement;
			const was = badge.textContent;
			badge.textContent = "9+";
			const measured = {
				gutterWidth: +document
					.querySelector(".cm-gutters")!
					.getBoundingClientRect()
					.width.toFixed(1),
				textLeft: +document
					.querySelector(".cm-line")!
					.getBoundingClientRect()
					.left.toFixed(1),
			};
			badge.textContent = was;
			return measured;
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

		await commentOnLine(0, "a thread on alpha");
		await commentOnLine(1, "a thread on beta");
		await commentOnLine(2, "a thread on gamma");
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("leaves a line carrying one thread as a bare icon", async () => {
		// A badge saying "1" tells the reader nothing the icon does not; the
		// tooltip says it, because that is where the exact number lives.
		expect(await badges()).toEqual(["", "", ""]);
		expect(await labels()).toEqual([
			"1 comment on this line",
			"1 comment on this line",
			"1 comment on this line",
		]);
	});

	it("badges a line that two threads have collapsed onto", async () => {
		const before = await textLeft();
		await joinNextLineOnto(0);

		expect(await badges()).toEqual(["2", ""]);
		expect(await labels()).toEqual(["2 comments on this line", "1 comment on this line"]);
		// The badge is readable, not clipped away by the gutter's fixed width.
		expect(await textLeft()).toBe(before);
		// The criterion from #68. The badge has to be taken to its widest to test
		// it: a marker sized by its contents survives one glyph on the gutter's
		// minimum width and only pushes the column out at two.
		const widest = await atWidestBadge();
		expect(widest.textLeft).toBe(before);
		expect(widest.gutterWidth).toBe(await gutterWidth());
	});

	it("keeps counting, and still does not move the text, at three", async () => {
		const before = await textLeft();
		await joinNextLineOnto(0);

		expect(await badges()).toEqual(["3"]);
		expect(await labels()).toEqual(["3 comments on this line"]);
		expect(await textLeft()).toBe(before);
		expect((await atWidestBadge()).textLeft).toBe(before);
	});

	it("lowers the count in the open editor when a thread is resolved", async () => {
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		await page.locator('[aria-label="Resolve"]').first().click();
		await page.waitForTimeout(1500);

		expect(await badges()).toEqual(["2"]);
	});

	it("drops the badge when the setting is switched off, without a reload", async () => {
		await setSetting("showCommentCount", false);
		expect(await badges()).toEqual([""]);
		// The marker itself is untouched: this setting is about the count.
		expect(await page.locator(".inline-comment-marker-active").count()).toBe(1);
	});

	it("brings it back the same way", async () => {
		await setSetting("showCommentCount", true);
		expect(await badges()).toEqual(["2"]);
	});
});
