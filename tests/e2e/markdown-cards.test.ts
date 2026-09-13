import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOTE = "alpha/note.md";
const BODY = ["first line of the note", "second line of the note", "third line of the note"].join(
	"\n",
);

/**
 * An internal link, because embeds are downgraded to links by the comment-body
 * sanitizer (#199). MarkdownRenderer does not mark unresolved links here —
 * [[nowhere-at-all]] renders with the same classes as a link that resolves —
 * so the DOM alone cannot tell a right sourcePath from a wrong one. We resolve
 * the linkpath through Obsidian's metadata cache, which uses the commented
 * note as the source.
 */
const LINK_COMMENT = "context: [[target]]";
const LONG_COMMENT = Array.from({ length: 30 }, (_, i) => `line ${i} of a very long comment`).join(
	"\n\n",
);

describe("markdown in comment cards", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;

	beforeAll(async () => {
		// Order matters here, which is why this is a literal rather than a loop.
		// Obsidian resolves [[target]] by exact path first, then by preferring the
		// source note's own folder, then by falling back to whichever target.md it
		// indexed first. Neither copy is at the vault root, so the first rule never
		// fires; the decoy is written first so it wins the fallback. A card handed
		// the wrong sourcePath therefore embeds the decoy, which is the only reason
		// this assertion can fail.
		vault = createTempVault({
			"zeta/target.md": "the decoy target",
			[NOTE]: BODY,
			"alpha/target.md": "the sibling target",
		});
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

		await addComment(1, LINK_COMMENT);
		await addComment(2, LONG_COMMENT);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-body", { timeout: 10000 });
		await page.waitForTimeout(1000);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	/** Write a comment on a line the way a person would: gutter, composer, send. */
	async function addComment(lineIndex: number, text: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(lineIndex).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(text);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}

	it("resolves an internal link against the commented note, not against the vault root", async () => {
		const link = page.locator(".inline-comment-body a.internal-link").first();
		await link.waitFor({ timeout: 10000 });
		expect(await link.getAttribute("data-href")).toBe("target");

		const resolved = await page.evaluate(() => {
			const file = window.app.metadataCache.getFirstLinkpathDest("target", "alpha/note.md");
			return file?.path ?? null;
		});
		expect(resolved).toBe("alpha/target.md");
		expect(resolved).not.toBe("zeta/target.md");
	});

	it("clips a long body and offers a way to see the rest", async () => {
		const body = page.locator(".inline-comment-body.is-clipped").first();
		await body.waitFor({ timeout: 10000 });

		const size = await body.evaluate((el: HTMLElement) => ({
			client: el.clientHeight,
			scroll: el.scrollHeight,
		}));
		// Clipped, and clipped to the documented cap rather than to whatever the
		// panel happened to be tall enough for.
		expect(size.client).toBeLessThan(size.scroll);
		expect(size.client).toBeLessThanOrEqual(220);

		// Qualified: every comment builds the control and hides it, so an
		// unqualified .first() picks the short comment's, which is never shown.
		const button = page.locator(".inline-comment-showmore.is-available").first();
		expect(await button.isVisible()).toBe(true);
		expect(await button.innerText()).toBe("Show more");
	});

	it("shows the whole body once the control is pressed, and hides it again", async () => {
		const button = page.locator(".inline-comment-showmore.is-available").first();
		await button.click();
		await page.waitForTimeout(300);

		const expanded = await page
			.locator(".inline-comment-showmore.is-available")
			.first()
			.evaluate((el: HTMLElement) => {
				const body = el.previousElementSibling as HTMLElement;
				return {
					client: body.clientHeight,
					scroll: body.scrollHeight,
					label: el.innerText,
				};
			});
		expect(expanded.client).toBe(expanded.scroll);
		expect(expanded.label).toBe("Show less");

		await button.click();
		await page.waitForTimeout(300);
		const collapsed = await page
			.locator(".inline-comment-showmore.is-available")
			.first()
			.evaluate((el: HTMLElement) => {
				const body = el.previousElementSibling as HTMLElement;
				return {
					client: body.clientHeight,
					scroll: body.scrollHeight,
					label: el.innerText,
				};
			});
		expect(collapsed.client).toBeLessThan(collapsed.scroll);
		expect(collapsed.label).toBe("Show more");
	});

	it("does not duplicate rendered links across repaints", async () => {
		// Every filter, sort, scope and settings change repaints the panel. An
		// internal link does not register a child component like an embed does,
		// but a leaked render would still leave extra DOM elements behind. Count
		// those instead: the panel outlives every repaint, so duplicates would
		// accumulate if the card were not torn down correctly.
		const countLinks = async (): Promise<number> =>
			page.locator(".inline-comment-body a.internal-link").count();

		const all = page.locator(".inline-comment-filter").first();
		await all.click();
		await page.waitForTimeout(600);
		const before = await countLinks();
		expect(before).toBe(1);

		for (let i = 0; i < 8; i++) {
			await all.click();
			await page.waitForTimeout(300);
		}
		await page.waitForTimeout(600);
		const after = await countLinks();

		expect(after).toBe(before);
		// And the same cards are still on screen, so this is not a count that
		// stayed flat because the panel stopped drawing anything.
		expect(await page.locator(".inline-comment-card").count()).toBe(2);
	});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
