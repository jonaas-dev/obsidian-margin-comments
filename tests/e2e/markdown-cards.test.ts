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
 * A local image, because its resolution is visible and sanitising keeps it.
 *
 * MarkdownRenderer does not mark unresolved links here — [[nowhere-at-all]]
 * renders with the same classes as a link that resolves — so a wikilink cannot
 * tell a right sourcePath from a wrong one. An embed could, but comment bodies are
 * sanitised and embeds become plain links (#199). An image's `src` names the file
 * it resolved to, and the two candidates below sit in different folders. The embed
 * rides along to prove it is not rendered as one.
 */
const IMAGE_COMMENT = "context: ![](pic.svg) and ![[target]]";
const LONG_COMMENT = Array.from({ length: 30 }, (_, i) => `line ${i} of a very long comment`).join(
	"\n\n",
);

describe("markdown in comment cards", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;

	beforeAll(async () => {
		// Order matters here, which is why this is a literal rather than a loop.
		// Obsidian resolves pic.svg by exact path first, then by preferring the
		// source note's own folder, then by falling back to whichever pic.svg it
		// indexed first. Neither copy is at the vault root, so the first rule never
		// fires; the decoy is written first so it wins the fallback. A card handed
		// the wrong sourcePath therefore shows the decoy, which is the only reason
		// that assertion can fail.
		vault = createTempVault({
			"zeta/pic.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
			"zeta/target.md": "the decoy target",
			[NOTE]: BODY,
			"alpha/pic.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
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

		await addComment(1, IMAGE_COMMENT);
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

	it("resolves a local image against the commented note, not against the vault root", async () => {
		const image = page.locator(".inline-comment-body img").first();
		await image.waitFor({ timeout: 10000 });
		const src = decodeURIComponent(await image.getAttribute("src"));
		expect(src).toContain("alpha/pic.svg");
		expect(src).not.toContain("zeta/pic.svg");
	});

	it("renders an embed as a link, without pulling the note into the card", async () => {
		const body = page.locator(".inline-comment-body").first();
		// A note embed renders as .markdown-embed. The image beside it is an
		// .internal-embed as well, so that class alone cannot tell them apart.
		expect(await body.locator(".markdown-embed").count()).toBe(0);
		expect(await body.locator('a.internal-link[data-href="target"]').count()).toBe(1);
		const text = await body.innerText();
		expect(text).not.toContain("the sibling target");
		expect(text).not.toContain("the decoy target");
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

	it("does not accumulate render components across repaints", async () => {
		// Every filter, sort, scope and settings change repaints the panel, and each
		// repaint renders every card body under a fresh component. Counted
		// rather than argued about: the panel outlives every repaint, so anything
		// hung off the view directly is never unloaded.
		const count = async (): Promise<number> =>
			page.evaluate(() => {
				const leaf = window.app.workspace.getLeavesOfType("margin-comments-panel")[0];
				const total = (component: any): number =>
					1 +
					(component._children ?? []).reduce((sum: number, c: any) => sum + total(c), 0);
				return total(leaf.view);
			});

		const all = page.locator(".inline-comment-filter").first();
		await all.click();
		await page.waitForTimeout(600);
		const before = await count();

		for (let i = 0; i < 8; i++) {
			await all.click();
			await page.waitForTimeout(300);
		}
		await page.waitForTimeout(600);
		const after = await count();

		expect(after).toBe(before);
		// And the same cards are still on screen, so this is not a count that
		// stayed flat because the panel stopped drawing anything.
		expect(await page.locator(".inline-comment-card").count()).toBe(2);
		expect(await page.locator(".inline-comment-body img").count()).toBe(1);
	});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
