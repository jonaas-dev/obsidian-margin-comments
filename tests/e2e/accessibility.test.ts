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

const FOCUSABLE =
	"a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * #33: everything is reachable without a mouse.
 *
 * The harness cannot hold DOM focus — `element.focus()` leaves
 * `document.activeElement` on `<body>` and pressing Tab moves nothing, because
 * Obsidian takes focus back. Simulating a Tab traversal here would assert
 * nothing at all. What is asserted instead is what makes Tab work: the controls
 * are focusable elements in the right order, the ones with no text say what they
 * do, and the focus ring resolves to a real colour.
 */
describe("keyboard and screen reader access", () => {
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

		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(0).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("a comment on the first line");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("exposes the panel as a landmark, so it can be jumped to", async () => {
		const landmark = await page.evaluate(() => {
			const panel = document.querySelector(".inline-comment-panel")!;
			return {
				role: panel.getAttribute("role"),
				label: panel.getAttribute("aria-label"),
			};
		});
		expect(landmark).toEqual({ role: "complementary", label: "Margin comments" });
	});

	it("gives every icon-only control a label", async () => {
		// The assertion is over whatever is on screen, not a list written here:
		// a list would go stale the moment someone adds a control, which is the
		// only way an unlabelled one ever ships.
		const unlabelled = await page.evaluate(() => {
			const panel = document.querySelector(".inline-comment-panel")!;
			return Array.from(panel.querySelectorAll("button, select"))
				.filter((el) => (el.textContent ?? "").trim() === "")
				.filter((el) => (el.getAttribute("aria-label") ?? "").trim() === "")
				.map((el) => el.className);
		});
		expect(unlabelled).toEqual([]);
	});

	it("makes the whole card reachable in reading order", async () => {
		// Tab order is DOM order, so this is the order a keyboard walks the card:
		// what it says first, then what can be done to it, then the reply.
		const order = await page.evaluate((selector: string) => {
			const card = document.querySelector(".inline-comment-card")!;
			return Array.from(card.querySelectorAll(selector)).map(
				(el) => el.getAttribute("aria-label") ?? el.className,
			);
		}, FOCUSABLE);

		expect(order).toEqual([
			'Go to "first line of the note" in the note',
			"Resolve",
			"Edit comment",
			"Delete comment",
			"inline-comment-showmore",
			"Write a reply",
			"Send reply",
		]);
	});

	it("reveals a thread from the quote, which a keyboard can activate", async () => {
		// A <button>, so Enter and Space come from the browser. The click handler
		// used to be on the card's div, reachable by pointer and by nothing else.
		const tag = await page.evaluate(
			() => document.querySelector(".inline-comment-quote")!.tagName,
		);
		expect(tag).toBe("BUTTON");

		await page.locator(".inline-comment-quote").first().click();
		await page.waitForTimeout(600);
		const cursorLine = await page.evaluate(() => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			return leaf.view.editor.getCursor().line;
		});
		expect(cursorLine).toBe(0);
	});

	it("draws a focus ring from the theme rather than leaving the default", async () => {
		// The browser default outline is invisible against a dark theme, and this
		// is read back computed rather than from the stylesheet: a rule that names
		// a variable the theme does not define resolves to nothing at all.
		// A Tab first, and it does not matter that it moves nothing: :focus-visible
		// asks whether the last interaction was a keyboard one, and everything up
		// to here has been mouse clicks. Without it the ring is correctly absent
		// and this test reports a stylesheet that is perfectly fine as broken.
		await page.keyboard.press("Tab");

		const outlines = await page.evaluate(() => {
			const of = (selector: string): string => {
				const el = document.querySelector(selector) as HTMLElement;
				el.focus();
				const style = getComputedStyle(el);
				return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
			};
			return {
				quote: of(".inline-comment-quote"),
				filter: of(".inline-comment-filter"),
				action: of(".inline-comment-action"),
			};
		});

		for (const [control, outline] of Object.entries(outlines) as [string, string][]) {
			expect({ control, solid: outline.startsWith("solid 2px rgb") }).toEqual({
				control,
				solid: true,
			});
		}
	});

	it("hands focus back when the composer is dismissed", async () => {
		// The other half of the criterion — the composer taking focus when it
		// opens — cannot be asserted here. Measured: the harness holds focus only
		// inside one synchronous block, and after any await document.activeElement
		// is <body>, whatever the plugin did. That half is on the manual pass.
		//
		// What this does assert is what the composer must do with the focus it
		// found: give it back. The capture happens in open(), which is why the
		// restore can be read even where the claim cannot.
		// The cursor goes to a line with no comment on it first: on a commented
		// line the command shows the thread that is already there rather than
		// composing a new one.
		await page.evaluate(() => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			leaf.view.editor.setCursor({ line: 2, ch: 0 });
		});

		const focus = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;

			const filter = document.querySelector(".inline-comment-filter") as HTMLElement;
			filter.focus();
			const held = document.activeElement === filter;

			plugin.routing.open(cm, 3);
			await new Promise((resolve) => setTimeout(resolve, 500));
			const composer = document.querySelector(".inline-comment-composer");

			plugin.routing.close();
			return { held, opened: composer !== null, restored: document.activeElement === filter };
		});

		expect(focus).toEqual({ held: true, opened: true, restored: true });
	});
});
