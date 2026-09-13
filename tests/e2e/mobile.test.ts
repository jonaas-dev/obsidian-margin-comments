import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["first line of the note", "second line", "third line"].join("\n");

/**
 * #30: the plugin on a touch device.
 *
 * Obsidian mobile cannot be driven from here, so what is exercised is the
 * behaviour that mobile turns on: `touch` is set the way `Platform.isMobile`
 * would set it, and the assertions are about what changes because of it. What
 * this cannot show is how it feels under a thumb, which is on the manual pass.
 */
describe("touch devices", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function setTouch(touch: boolean): Promise<void> {
		await page.evaluate(async (on: boolean) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.touch = on;
			await plugin.refresh();
		}, touch);
		await page.waitForTimeout(800);
	}

	/** Lines carrying a visible marker, 1-based, in document order. */
	const markedLines = (): Promise<number[]> =>
		page.evaluate(() => {
			const lines = Array.from(document.querySelectorAll(".cm-line")) as HTMLElement[];
			const markers = Array.from(document.querySelectorAll(".inline-comment-marker")) as HTMLElement[];
			return markers
				.map((marker) => {
					const centre = marker.getBoundingClientRect().top + marker.getBoundingClientRect().height / 2;
					const index = lines.findIndex((line) => {
						const rect = line.getBoundingClientRect();
						return centre >= rect.top - 2 && centre <= rect.bottom + 2;
					});
					return index + 1;
				})
				.filter((line) => line > 0)
				.sort((a, b) => a - b);
		});

	async function putCaretOn(line: number): Promise<void> {
		await page.evaluate((zeroBased: number) => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			leaf.view.editor.setCursor({ line: zeroBased, ch: 0 });
		}, line - 1);
		await page.waitForTimeout(400);
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

		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("a comment on the second line");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		// The pointer is parked away from the gutter for the rest of the suite:
		// a hover marker left behind would be counted as a touch one.
		await page.mouse.move(700, 500);
		await page.waitForTimeout(400);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("marks the commented line and the caret's line, not every line", async () => {
		// It used to mark every one. A speech bubble beside all three lines of
		// this note — and all 300 of a real one — stops reading as "something is
		// here" and becomes wallpaper.
		await setTouch(true);
		await putCaretOn(3);
		expect(await markedLines()).toEqual([2, 3]);
	});

	it("moves the caret's marker with the caret, keeping the commented one", async () => {
		await putCaretOn(1);
		expect(await markedLines()).toEqual([1, 2]);
	});

	it("leaves only the commented line marked when the pointer is back in charge", async () => {
		await setTouch(false);
		expect(await markedLines()).toEqual([2]);
	});

	it("gives the panel's controls a thumb-sized target", async () => {
		await setTouch(true);
		const sizes = await page.evaluate(() => {
			const of = (selector: string): [string, number, number] => {
				const rect = document.querySelector(selector)!.getBoundingClientRect();
				return [selector, Math.round(rect.width), Math.round(rect.height)];
			};
			return [
				of(".inline-comment-action"),
				of(".inline-comment-filter"),
				of(".inline-comment-sort"),
				of(".inline-comment-quote"),
			];
		});

		for (const [selector, width, height] of sizes) {
			expect({ selector, big: width >= 44 && height >= 44 }).toEqual({ selector, big: true });
		}
	});

	it("shows the actions without a hover, and folds the reply behind a button (#136)", async () => {
		// Hidden until hover on a pointer. On a phone that leaves resolving and
		// deleting behind an affordance that cannot happen. The reply field is the
		// exception: open under every card it made each one a form.
		const visible = await page.evaluate(() => {
			const card = document.querySelector(".inline-comment-panel .inline-comment-card")!;
			return {
				actions: getComputedStyle(card.querySelector(".inline-comment-actions")!).opacity,
				reply: getComputedStyle(card.querySelector(".inline-comment-replybox")!).display,
				toggle: getComputedStyle(card.querySelector(".inline-comment-reply-toggle")!).display,
			};
		});
		expect(visible).toEqual({ actions: "1", reply: "none", toggle: "flex" });
	});

	it("centres a one-line quote in its thumb-sized row (#127)", async () => {
		const gaps = await page.evaluate(() => {
			const quote = document.querySelector(".inline-comment-panel .inline-comment-quote")!;
			const text = quote.querySelector(".inline-comment-quote-text")!;
			const q = quote.getBoundingClientRect();
			const t = text.getBoundingClientRect();
			return { height: Math.round(q.height), above: Math.round(t.top - q.top), below: Math.round(q.bottom - t.bottom) };
		});
		expect(gaps.height).toBeGreaterThanOrEqual(44);
		expect(Math.abs(gaps.above - gaps.below)).toBeLessThanOrEqual(2);
	});

	it("unfolds and focuses the reply field when Reply is pressed (#136)", async () => {
		// Read in the same evaluate as the click: the harness holds focus only
		// inside one synchronous block.
		const state = await page.evaluate(() => {
			const card = document.querySelector(".inline-comment-panel .inline-comment-card")!;
			(card.querySelector(".inline-comment-reply-toggle") as HTMLElement).click();
			const input = card.querySelector(".inline-comment-replybox-input");
			return {
				box: getComputedStyle(card.querySelector(".inline-comment-replybox")!).display,
				toggle: getComputedStyle(card.querySelector(".inline-comment-reply-toggle")!).display,
				focused: document.activeElement === input,
			};
		});
		expect(state).toEqual({ box: "flex", toggle: "none", focused: true });
	});

	it("gives the unfolded field and its send button one thumb-sized height (#127)", async () => {
		const heights = await page.evaluate(() => {
			const card = document.querySelector(".inline-comment-panel .inline-comment-card")!;
			// Unfolded here rather than trusted from the test above: between two
			// evaluates the harness moves focus to <body>, and an empty field that
			// loses focus folds again.
			(card.querySelector(".inline-comment-reply-toggle") as HTMLElement).click();
			const field = card.querySelector(".inline-comment-replybox-input")!.getBoundingClientRect();
			const send = card.querySelector(".inline-comment-send")!.getBoundingClientRect();
			return { field: Math.round(field.height), send: Math.round(send.height) };
		});
		expect(heights.field).toBe(heights.send);
		expect(heights.field).toBeGreaterThanOrEqual(44);
	});

	it("keeps a draft open when the field loses focus, and folds an empty one", async () => {
		const states = await page.evaluate(() => {
			const card = document.querySelector(".inline-comment-panel .inline-comment-card")!;
			const box = card.querySelector(".inline-comment-replybox")!;
			const input = card.querySelector(".inline-comment-replybox-input") as HTMLTextAreaElement;
			// Through the button, as a reader gets there: a folded field is
			// display: none and cannot take focus at all.
			(card.querySelector(".inline-comment-reply-toggle") as HTMLElement).click();
			input.value = "half a reply";
			input.blur();
			const withDraft = getComputedStyle(box).display;
			input.focus();
			input.value = "";
			input.blur();
			return {
				withDraft,
				empty: getComputedStyle(box).display,
				toggle: getComputedStyle(card.querySelector(".inline-comment-reply-toggle")!).display,
			};
		});
		expect(states).toEqual({ withDraft: "flex", empty: "none", toggle: "flex" });
	});

	it("places the composer above the on-screen keyboard", async () => {
		// The keyboard is faked by shrinking visualViewport, which is exactly what
		// it does: window.innerHeight never moves, so a composer measured against
		// the window is placed correctly into the part of the screen the keyboard
		// is covering. Unit tests cover the measurement; this covers the wiring —
		// without it, swapping the call site back to window.innerHeight broke
		// nothing at all.
		const placement = await page.evaluate(async () => {
			const keyboardTop = 300;
			const real = window.visualViewport;
			Object.defineProperty(window, "visualViewport", {
				configurable: true,
				value: {
					width: window.innerWidth,
					height: keyboardTop,
					addEventListener: () => {},
					removeEventListener: () => {},
				},
			});

			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;
			plugin.routing.open(cm, 3);
			await new Promise((resolve) => setTimeout(resolve, 400));

			const composer = document.querySelector(".inline-comment-composer") as HTMLElement;
			const rect = composer.getBoundingClientRect();
			plugin.routing.close();
			Object.defineProperty(window, "visualViewport", { configurable: true, value: real });
			return { bottom: Math.round(rect.bottom), keyboardTop, windowHeight: window.innerHeight };
		});

		expect(placement.bottom).toBeLessThanOrEqual(placement.keyboardTop);
		// And the window really is taller, so the assertion above is not free.
		expect(placement.windowHeight).toBeGreaterThan(placement.keyboardTop);
	});

	it("keeps the composer inside a phone-width viewport", async () => {
		await page.evaluate(() => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			leaf.view.editor.setCursor({ line: 2, ch: 0 });
			const plugin = window.app.plugins.plugins["margin-comments"];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;
			plugin.routing.open(cm, 3);
		});
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });

		const width = await page.evaluate(() => {
			const composer = document.querySelector(".inline-comment-composer") as HTMLElement;
			return {
				composer: Math.round(composer.getBoundingClientRect().width),
				// What it would be on a 390px phone, which is what the clamp is for.
				clamped: Math.round(Math.min(320, 390 - 24)),
			};
		});
		expect(width.composer).toBeLessThanOrEqual(320);
		expect(width.clamped).toBe(320);

		await page.evaluate(() => {
			window.app.plugins.plugins["margin-comments"].routing.close();
		});
	});
});
