import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["alpha one", "beta two", "gamma three"].join("\n");

/**
 * #102: arriving from the editor marks a card, and that mark is temporary.
 *
 * It used to be permanent and to look exactly like hover — the same
 * `--background-modifier-hover` on both — so two cards read as active at once
 * and the arrival marker never let go.
 */
describe("the selected card", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const selectedCount = (): Promise<number> =>
		page.evaluate(() => document.querySelectorAll(".inline-comment-card.is-selected").length);

	/** Click a line's gutter marker, which is how a reader arrives from the note. */
	async function arriveFrom(lineIndex: number): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(lineIndex).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForTimeout(400);
		await page.mouse.click(x, y);
		await page.waitForTimeout(900);
	}

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
			const cm = (leaf.view.editor as unknown as { cm: { state: { doc: { toString(): string } } } }).cm;
			const doc = cm.state.doc.toString();
			for (const word of ["alpha", "beta", "gamma"]) {
				const at = doc.indexOf(word);
				await plugin.createComment(cm, leaf.view.file.path, at, at + word.length, `On ${word}.`);
			}
		});
		await page.waitForTimeout(1500);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("has three cards, so 'exactly one selected' can fail", async () => {
		expect(await page.locator(".inline-comment-card").count()).toBe(3);
	});

	it("does not look like a hovered card", async () => {
		// Both read the same way, as computed backgrounds. The first version of
		// this compared the selected card's *computed* colour against the raw
		// text of --background-modifier-hover, which are two spellings of the
		// same colour — so it passed with the two states identical, which is the
		// bug it was written for.
		await page.evaluate(() => {
			(document.querySelectorAll(".inline-comment-card")[0] as HTMLElement).classList.add(
				"is-selected",
			);
		});
		await page.locator(".inline-comment-card").nth(1).hover();
		await page.waitForTimeout(400);

		const colours = await page.evaluate(() => {
			const cards = Array.from(
				document.querySelectorAll(".inline-comment-card"),
			) as HTMLElement[];
			const out = {
				selected: getComputedStyle(cards[0]).backgroundColor,
				hovered: getComputedStyle(cards[1]).backgroundColor,
			};
			cards[0].classList.remove("is-selected");
			return out;
		});

		// Measured before: both oklch(0 0 none / 0.067).
		expect(colours.selected).not.toBe(colours.hovered);
	});

	it("takes its colour from the theme's accent", async () => {
		const painted = await page.evaluate(async () => {
			document.body.style.setProperty("--text-accent", "rgb(1, 2, 3)");
			const card = document.querySelector(".inline-comment-card") as HTMLElement;
			card.classList.add("is-selected");
			await new Promise((r) => setTimeout(r, 300));
			const shadow = getComputedStyle(card).boxShadow;
			card.classList.remove("is-selected");
			document.body.style.removeProperty("--text-accent");
			return shadow;
		});
		expect(painted).toContain("rgb(1, 2, 3)");
	});

	it("marks the card the reader arrived at", async () => {
		await arriveFrom(1);
		expect(await selectedCount()).toBe(1);
	});

	it("lets go when the reader reaches a different card", async () => {
		// The report: hovering the other comments never cleared it, so two cards
		// read as active together.
		await arriveFrom(1);
		expect(await selectedCount()).toBe(1);

		await page.locator(".inline-comment-card").last().hover();
		await page.waitForTimeout(400);
		expect(await selectedCount()).toBe(0);
	});

	it("keeps the mark while the pointer stays on the card it arrived at", async () => {
		// Clearing on any hover at all would drop it before it has been read.
		await arriveFrom(1);
		const selected = await page.locator(".inline-comment-card.is-selected").first();
		await selected.hover();
		await page.waitForTimeout(400);
		expect(await selectedCount()).toBe(1);
	});

	it("lets go on a press anywhere in the panel", async () => {
		await arriveFrom(1);
		expect(await selectedCount()).toBe(1);

		await page.locator(".inline-comment-filter").first().click();
		await page.waitForTimeout(700);
		expect(await selectedCount()).toBe(0);
	});

	it("lets go on a press outside the panel", async () => {
		// #119: only presses inside the panel reached the listener, so clicking
		// back into the note left the card marked indefinitely.
		await arriveFrom(1);
		expect(await selectedCount()).toBe(1);

		// Past the end of the text, so no comment highlight takes the press.
		const line = await page.locator(".cm-line").nth(0).boundingBox();
		await page.mouse.click(line.x + line.width - 10, line.y + line.height / 2);
		await page.waitForTimeout(700);
		expect(await selectedCount()).toBe(0);
	});

	it("moves to the new card when another marker is pressed", async () => {
		// Clearing on every press also fires for the marker press itself, so the
		// clear must land before the new selection rather than wipe it.
		await arriveFrom(1);
		await arriveFrom(2);
		const selected = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-card.is-selected")).map(
				(card) => card.textContent ?? "",
			),
		);
		expect(selected).toHaveLength(1);
		expect(selected[0]).toContain("On gamma.");
	});
});
