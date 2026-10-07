import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["alpha beta gamma", "delta epsilon"].join("\n");

interface EditorViewLike {
	state: { doc: { toString(): string } };
}

/**
 * #101 and #103: the panel's controls fit what they hold.
 *
 * Both came from overriding a size Obsidian had already reasoned about — the
 * reply field's font, and the horizontal padding a `<select>` needs for the
 * arrow it draws itself.
 */
describe("the panel's proportions", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

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
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + 4,
				"A comment body.",
			);
		});
		await page.waitForTimeout(1200);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("gives the reply field and its button the same height (#101)", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.locator(".inline-comment-replybox-input").first().click();
		await page.locator(".inline-comment-replybox-input").first().fill("x");
		await page.waitForTimeout(400);

		const sizes = await page.evaluate(() => {
			const box = (sel: string) => {
				const el = document.querySelector(sel) as HTMLElement;
				return {
					h: Math.round(el.getBoundingClientRect().height),
					fs: parseFloat(getComputedStyle(el).fontSize),
				};
			};
			return {
				field: box(".inline-comment-replybox-input"),
				send: box(".inline-comment-send"),
			};
		});

		// Measured before: field 20px at 10.4px, button 25px. The same 1.9em in
		// two different ems.
		expect(Math.abs(sizes.field.h - sizes.send.h)).toBeLessThanOrEqual(1);
	});

	it("does not make the reply field the smallest text in the card (#101)", async () => {
		const sizes = await page.evaluate(() => ({
			field: parseFloat(
				getComputedStyle(
					document.querySelector(".inline-comment-replybox-input") as HTMLElement,
				).fontSize,
			),
			body: parseFloat(
				getComputedStyle(document.querySelector(".inline-comment-body") as HTMLElement)
					.fontSize,
			),
		}));
		expect(sizes.field).toBeGreaterThanOrEqual(sizes.body);
	});

	it("leaves a dropdown room for the arrow it draws itself (#103)", async () => {
		// Not an overflow test: scrollWidth equalled clientWidth throughout, the
		// control was simply narrower than its label plus its own arrow. So the
		// assertion is that our rule stopped flattening the padding Obsidian
		// reserves on the side the arrow sits.
		const room = await page.evaluate(() => {
			const measure = (sel: string) => {
				const el = document.querySelector(sel) as HTMLElement;
				const cs = getComputedStyle(el);
				const longest = Math.max(
					...Array.from(el.querySelectorAll("option")).map(
						(o) => (o.textContent ?? "").length,
					),
				);
				return {
					paddingRight: parseFloat(cs.paddingRight),
					paddingLeft: parseFloat(cs.paddingLeft),
					width: Math.round(el.getBoundingClientRect().width),
					longest,
				};
			};
			return {
				scope: measure(".inline-comment-scope"),
				sort: measure(".inline-comment-sort"),
			};
		});

		// Obsidian's .dropdown reserves the right side; ours used to set both to
		// 5.2px, which is what put the arrow on top of the last glyph.
		expect(room.scope.paddingRight).toBeGreaterThan(room.scope.paddingLeft);
		expect(room.sort.paddingRight).toBeGreaterThan(room.sort.paddingLeft);
	});

	it("fits the scope label at the panel's default width (#103)", async () => {
		// The label plus the arrow, against the control. Measured in a canvas so
		// the answer does not depend on the font happening to be loaded.
		const fits = await page.evaluate(() => {
			const el = document.querySelector(".inline-comment-scope") as HTMLElement;
			const cs = getComputedStyle(el);
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d")!;
			ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
			const widest = Math.max(
				...Array.from(el.querySelectorAll("option")).map(
					(o) => ctx.measureText(o.textContent ?? "").width,
				),
			);
			const inner =
				el.getBoundingClientRect().width -
				parseFloat(cs.paddingLeft) -
				parseFloat(cs.paddingRight);
			return { widest: Math.round(widest), inner: Math.round(inner) };
		});
		expect(fits.inner).toBeGreaterThanOrEqual(fits.widest);
	});
});
