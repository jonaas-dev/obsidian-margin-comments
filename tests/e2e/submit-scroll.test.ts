import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "clipping.md";

/**
 * Shaped like a Web Clipper note, which is where #367 was reported, and the
 * shape is load-bearing. Plain short lines showed no jump at any depth from 600
 * to 4000px, and neither did a three-field frontmatter; with this one main jumped
 * back to the top on 1.13.7 and 1.14.4 alike.
 */
const LINES: string[] = [
	"---",
	'title: "A clipped article"',
	'source: "https://example.com/article"',
	"author:",
	'  - "[[Someone]]"',
	"published: 2026-01-01",
	"created: 2026-10-20",
	'description: "A long description"',
	"tags:",
	'  - "clippings"',
	"---",
];
for (let i = 0; i < 160; i++) {
	if (i % 10 === 0) LINES.push(`## Section ${i / 10}`, "");
	if (i % 13 === 0) LINES.push(`![image ${i}](https://example.invalid/img${i}.png)`, "");
	LINES.push(`Paragraph ${i} ` + "lorem ipsum dolor sit amet consectetur ".repeat(12), "");
}

/** The note's scroll position, read the moment it is asked for. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scrollTop(page: any): Promise<number> {
	return page.evaluate(
		() => document.querySelector(".workspace-leaf.mod-active .cm-scroller")?.scrollTop ?? -1,
	);
}

describe("closing the composer keeps the note where it was (#367)", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: LINES.join("\n") });
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
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	/**
	 * Read down a note the way #367 did: scroll, never click into the text, and
	 * comment from the gutter. The caret stays at the top of the note, which is
	 * what the editor scrolls back to when it is handed focus without
	 * `preventScroll` — a caret beside the commented line hides the bug.
	 */
	async function openComposerFarDown(top: number): Promise<number> {
		await page.evaluate((to: number) => {
			const scroller = document.querySelector(".workspace-leaf.mod-active .cm-scroller");
			if (scroller) scroller.scrollTop = to;
		}, top);
		await page.waitForTimeout(300);
		const scroller = await page
			.locator(".workspace-leaf.mod-active .cm-scroller")
			.boundingBox();
		const gutters = await page.locator(".workspace-leaf.mod-active .cm-gutters").boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = scroller.y + scroller.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		const before = await scrollTop(page);
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		// The composer remembers what had focus when it opened, and here that is
		// <body>: the routing awaits the sidecar first, and the harness drops focus
		// across any await. Measured with focus() instrumented, the editor was never
		// handed focus back, so this passed against the bug. A reader's editor does
		// have focus, so give the composer what it would have remembered.
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.routing.composer.returnFocusTo = document.querySelector(
				".workspace-leaf.mod-active .cm-content",
			);
		});
		expect(before).toBeGreaterThan(top - 100);
		return before;
	}

	it("after submitting", async () => {
		const before = await openComposerFarDown(4000);
		await page.locator(".inline-comment-composer-input").fill("far down");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForFunction(
			() => document.querySelector(".inline-comment-composer") === null,
			null,
			{ timeout: 5000 },
		);
		await page.waitForTimeout(500);
		expect(Math.abs((await scrollTop(page)) - before)).toBeLessThan(50);
	});

	it("after cancelling", async () => {
		const before = await openComposerFarDown(6000);
		await page.locator(".inline-comment-composer-input").fill("never mind");
		await page.keyboard.press("Escape");
		await page.evaluate(() => {
			document
				.querySelector<HTMLButtonElement>(".inline-comment-composer button:not(.mod-cta)")
				?.click();
		});
		await page.waitForFunction(
			() => document.querySelector(".inline-comment-composer") === null,
			null,
			{ timeout: 5000 },
		);
		await page.waitForTimeout(500);
		expect(Math.abs((await scrollTop(page)) - before)).toBeLessThan(50);
	});
});
