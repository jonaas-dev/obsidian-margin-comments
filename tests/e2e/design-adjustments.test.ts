import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { toString(): string; line(n: number): { from: number } } };
}

const NOTE = "note.md";
const BODY = [
	"alpha beta gamma",
	"",
	"```js",
	"const answer = 42;",
	"```",
	"",
	"delta epsilon",
].join("\n");

/**
 * Decisions from the Android design review that are about layout and colour.
 *
 * #139: filter and sort share a row when the panel is wide; a short panel is compact.
 * #142: stronger dark tint; the badge in the marker's colour, anchored to its icon.
 * #140: a highlight inside a code block is one band, not a pill per token.
 */
describe("layout and colour adjustments", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Alpha of a computed colour, in either of the forms Chromium reports. */
	const alphaOf = (colour: string): number => {
		const slash = colour.match(/\/\s*([\d.]+)\s*\)$/);
		if (slash) return Number(slash[1]);
		const rgba = colour.match(/rgba\([^)]*,\s*([\d.]+)\s*\)$/);
		return rgba ? Number(rgba[1]) : 1;
	};

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
			const on = async (needle: string) => {
				const at = doc.indexOf(needle);
				await plugin.routing.createComment(
					cm,
					leaf.view.file.path,
					at,
					at + needle.length,
					`On ${needle}.`,
				);
			};
			await on("beta");
			await on("gamma");
			await on("answer = 42");
			// from === to asks for a whole-line comment, which is what tints a line.
			const delta = cm.state.doc.line(7).from;
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				delta,
				delta,
				"On the whole line.",
			);
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", {
			timeout: 10000,
		});
		// The pointer away from the gutter, so hover markers do not join the count.
		await page.mouse.move(900, 500);
		await page.waitForTimeout(800);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("puts filter and sort on one row in a wide panel, and stacks them in a narrow one (#139)", async () => {
		const rows = await page.evaluate(async () => {
			const panel = document.querySelector(".inline-comment-panel") as HTMLElement;
			const measure = async (width: string) => {
				panel.style.width = width;
				await new Promise((r) => setTimeout(r, 300));
				const filters = panel
					.querySelector(".inline-comment-filters")!
					.getBoundingClientRect();
				const sort = panel
					.querySelector(".inline-comment-sortbar")!
					.getBoundingClientRect();
				return {
					sameRow: Math.abs(sort.top - filters.top) <= 4,
					sortBelow: sort.top >= filters.bottom - 1,
				};
			};
			const wide = await measure("460px");
			const narrow = await measure("300px");
			panel.style.width = "";
			return { wide, narrow };
		});
		expect(rows.wide).toEqual({ sameRow: true, sortBelow: false });
		expect(rows.narrow).toEqual({ sameRow: false, sortBelow: true });
	});

	it("compacts the header in a short panel (#139)", async () => {
		const heights = await page.evaluate(async () => {
			const panel = document.querySelector(".inline-comment-panel") as HTMLElement;
			const block = async (height: string) => {
				panel.style.height = height;
				await new Promise((r) => setTimeout(r, 300));
				const top = panel
					.querySelector(".inline-comment-panel-header")!
					.getBoundingClientRect().top;
				const bottom = panel
					.querySelector(".inline-comment-sortbar")!
					.getBoundingClientRect().bottom;
				return bottom - top;
			};
			const tall = await block("900px");
			const short = await block("400px");
			panel.style.height = "";
			return { tall, short };
		});
		expect(heights.short).toBeLessThan(heights.tall);
	});

	it("paints a highlight inside a code block as one band (#140)", async () => {
		const radii = await page.evaluate(() =>
			Array.from(
				document.querySelectorAll(".HyperMD-codeblock .inline-comment-active-range"),
			).map((el) => getComputedStyle(el).borderTopLeftRadius),
		);
		// Guard: a note whose code line carries no range would pass with nothing to check.
		expect(radii.length).toBeGreaterThan(1);
		expect(new Set(radii)).toEqual(new Set(["0px"]));
	});

	it("badges the count in the marker's own colour (#142)", async () => {
		const colours = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const before = plugin.settings.highlightColor;
			plugin.settings.highlightColor = "#e5a50a";
			plugin.applyHighlightColour();
			await plugin.refresh();
			await new Promise((r) => setTimeout(r, 400));
			const badge = document.querySelector(".inline-comment-marker-count") as HTMLElement;
			const marker = badge.closest(".inline-comment-marker") as HTMLElement;
			const out = {
				badge: getComputedStyle(badge).backgroundColor,
				marker: getComputedStyle(marker).color,
			};
			plugin.settings.highlightColor = before;
			plugin.applyHighlightColour();
			await plugin.refresh();
			return out;
		});
		expect(colours.badge).toBe(colours.marker);
		expect(colours.marker).toBe("rgb(229, 165, 10)");
	});

	it("keeps the badge on its icon when the text is larger (#142)", async () => {
		const geometry = await page.evaluate(async () => {
			document.body.style.setProperty("--font-text-size", "30px");
			await new Promise((r) => setTimeout(r, 600));
			const badge = document.querySelector(".inline-comment-marker-count") as HTMLElement;
			const icon = badge
				.closest(".inline-comment-marker")!
				.querySelector(".svg-icon") as SVGElement;
			const b = badge.getBoundingClientRect();
			const i = icon.getBoundingClientRect();
			const line = document.querySelector(".cm-line")!.getBoundingClientRect();
			document.body.style.removeProperty("--font-text-size");
			return {
				overlaps:
					b.left < i.right && b.right > i.left && b.top < i.bottom && b.bottom > i.top,
				// Guard: the line has to be taller than the icon for the old anchoring to drift.
				lineTaller: line.height > i.height * 1.5,
			};
		});
		expect(geometry.lineTaller).toBe(true);
		expect(geometry.overlaps).toBe(true);
	});

	it("tints a commented line more strongly in a dark theme (#142)", async () => {
		const tint = async (theme: string): Promise<string> =>
			page.evaluate(async (name: string) => {
				(window.app as unknown as { changeTheme(n: string): void }).changeTheme(name);
				await new Promise((r) => setTimeout(r, 700));
				return getComputedStyle(
					document.querySelector(".inline-comment-active-line") as HTMLElement,
				).backgroundColor;
			}, theme);
		const dark = alphaOf(await tint("obsidian"));
		const light = alphaOf(await tint("moonstone"));
		expect(dark).toBeGreaterThan(light);
	});
});
