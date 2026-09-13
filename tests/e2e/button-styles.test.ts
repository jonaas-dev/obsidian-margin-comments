import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["# Heading", "", "A paragraph with a target word in it.", "", "Another paragraph."].join(
	"\n",
);

interface EditorViewLike {
	state: { doc: { toString(): string } };
}

/**
 * #96: the plugin's own styles have to actually reach its buttons.
 *
 * Obsidian styles `button:not(.clickable-icon)` at specificity (0,1,1), which
 * beats a lone class — so five families of button were being painted by the app
 * rather than by styles.css: a filled chip under every icon, no hover response
 * at all, and the quoted text centred because the app's rule brings
 * justify-content with it.
 *
 * Every assertion here reads computed style. The stylesheet said the right
 * thing the whole time; it was losing the cascade.
 */
describe("the plugin's buttons", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const TRANSPARENT = "rgba(0, 0, 0, 0)";

	const styleOf = (selector: string): Promise<{ bg: string; color: string }> =>
		page.evaluate((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement;
			const cs = getComputedStyle(el);
			return { bg: cs.backgroundColor, color: cs.color };
		}, selector);

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

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const doc = cm.state.doc.toString();
			const at = doc.indexOf("target word");
			await plugin.routing.createComment(cm, leaf.view.file.path, at, at + "target word".length, "A comment.");
		});
		await page.waitForTimeout(1200);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		// Hover the card so its actions are on screen and measurable.
		await page.locator(".inline-comment-card").first().hover();
		await page.waitForTimeout(500);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("leaves no filled chip under an icon", async () => {
		// What shipped: every icon carried Obsidian's --interactive-normal.
		for (const label of ["Resolve", "Edit comment", "Delete comment"]) {
			const style = await styleOf(`[aria-label="${label}"]`);
			expect({ label, bg: style.bg }).toEqual({ label, bg: TRANSPARENT });
		}
	});

	it("responds when the pointer arrives on an icon", async () => {
		const before = await styleOf('[aria-label="Edit comment"]');
		await page.locator('[aria-label="Edit comment"]').first().hover();
		await page.waitForTimeout(400);
		const after = await styleOf('[aria-label="Edit comment"]');

		// Something has to change. Measured before the fix, both readings were
		// identical: rgb(34,34,34) on rgb(228,228,228), pointer on and off.
		expect(`${after.bg}|${after.color}`).not.toBe(`${before.bg}|${before.color}`);
	});

	it("keeps the panel's own controls flat until they are chosen", async () => {
		// The filter bar is meant to read as one quiet segmented control above a
		// reading list, not as three filled buttons.
		const inactive = await page.evaluate(() => {
			const el = Array.from(document.querySelectorAll(".inline-comment-filter")).find(
				(f) => !f.classList.contains("is-active"),
			) as HTMLElement;
			return getComputedStyle(el).backgroundColor;
		});
		expect(inactive).toBe(TRANSPARENT);

		expect((await styleOf(".inline-comment-showmore, .inline-comment-card")).bg).not.toBe("");
	});

	it("starts the quoted text at the left edge of the card", async () => {
		// #33 made the quote a <button> for the keyboard and inherited
		// justify-content: center with it, so the commented text sat centred.
		const quote = await page.evaluate(() => {
			const el = document.querySelector(".inline-comment-quote") as HTMLElement;
			const span = el.querySelector("span") as HTMLElement;
			return {
				justify: getComputedStyle(el).justifyContent,
				gap: Math.round(span.getBoundingClientRect().left - el.getBoundingClientRect().left),
				width: Math.round(el.getBoundingClientRect().width),
			};
		});
		expect(quote.justify).toBe("flex-start");
		// Its own padding, not a third of the card.
		expect(quote.gap).toBeLessThan(quote.width / 4);
	});

	it("paints the send button from the theme's accent", async () => {
		await page.locator(".inline-comment-replybox-input").first().click();
		await page.locator(".inline-comment-replybox-input").first().fill("x");
		await page.waitForTimeout(400);

		const painted = await page.evaluate(async () => {
			document.body.style.setProperty("--interactive-accent", "rgb(1, 2, 3)");
			await new Promise((r) => setTimeout(r, 300));
			const bg = getComputedStyle(
				document.querySelector(".inline-comment-send") as HTMLElement,
			).backgroundColor;
			document.body.style.removeProperty("--interactive-accent");
			return bg;
		});
		// Demanded back exactly: the plugin's rule was losing to the app's, so
		// the primary action rendered as the same grey as everything else.
		expect(painted).toBe("rgb(1, 2, 3)");
	});
});
