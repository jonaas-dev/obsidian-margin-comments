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
	dispatch(spec: unknown): void;
	coordsAtPos(pos: number): { top: number; bottom: number } | null;
}

const NOTE = "note.md";
const LINES = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a note long enough to scroll.`);
const COMMENTED = 60;

type Rect = { left: number; right: number; top: number; bottom: number };

/**
 * #135: on a phone the composer and the popover are a bottom sheet, and the
 * note keeps the commented line in view above it.
 *
 * Driven with `plugin.sheet`, the way the touch suite drives `touch`: Obsidian
 * desktop cannot be a phone, but what the flag switches on can be measured.
 */
describe("the bottom sheet", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Activate a line with no selection, then measure the widget and the line. */
	async function openOn(line: number, selector: string): Promise<{ widget: Rect | null; line: Rect | null; innerWidth: number; innerHeight: number; placement: string | null }> {
		return page.evaluate(
			async ([at, sel]: [number, string]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				cm.dispatch({ selection: { anchor: 0, head: 0 } });
				plugin.openComposer(cm, at);
				await new Promise((r) => setTimeout(r, 900));
				const el = document.querySelector(sel) as HTMLElement | null;
				const rect = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
				const coords = cm.coordsAtPos(cm.state.doc.line(at).from);
				return {
					widget: el ? rect(el.getBoundingClientRect()) : null,
					line: coords ? { left: 0, right: 0, top: coords.top, bottom: coords.bottom } : null,
					innerWidth: window.innerWidth,
					innerHeight: window.innerHeight,
					placement: el ? el.dataset.placement ?? null : null,
				};
			},
			[line, selector],
		);
	}

	async function closeAll(): Promise<void> {
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.composer?.close();
			plugin.popover?.close();
			document.querySelector(".mobile-navbar.qa-fake")?.remove();
			document.documentElement.style.removeProperty("--keyboard-height");
			document.body.removeClass("is-hidden-nav");
		});
		await page.waitForTimeout(300);
	}

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
		await page.evaluate(async (commented: number) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const from = cm.state.doc.line(commented).from;
			await plugin.createComment(cm, leaf.view.file.path, from, from + 4, "A comment far down the note.");
			plugin.sheet = true;
		}, COMMENTED);
		await page.waitForTimeout(800);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("spans the width and sits on the bottom of the window", async () => {
		const m = await openOn(COMMENTED - 5, ".inline-comment-composer");
		expect(m.placement).toBe("sheet");
		expect(Math.round(m.widget!.left)).toBe(0);
		expect(Math.round(m.widget!.right)).toBe(m.innerWidth);
		expect(Math.round(m.widget!.bottom)).toBe(m.innerHeight);
		await closeAll();
	});

	it("keeps the commented line in view above the composer", async () => {
		// The line starts far below the fold, so this fails unless the note scrolls.
		const m = await openOn(COMMENTED - 5, ".inline-comment-composer");
		expect(m.line!.top).toBeGreaterThanOrEqual(0);
		expect(m.line!.bottom).toBeLessThanOrEqual(m.widget!.top);
		await closeAll();
	});

	it("keeps the commented line in view above the popover", async () => {
		const m = await openOn(COMMENTED, ".inline-comment-popover");
		expect(m.placement).toBe("sheet");
		expect(m.line!.top).toBeGreaterThanOrEqual(0);
		expect(m.line!.bottom).toBeLessThanOrEqual(m.widget!.top);
		await closeAll();
	});

	it("stays clear of Obsidian's mobile navigation bar (#132)", async () => {
		await page.evaluate(() => {
			const bar = document.body.createDiv({ cls: "mobile-navbar qa-fake" });
			Object.assign(bar.style, { position: "fixed", left: "0", right: "0", bottom: "20px", height: "52px" });
		});
		const m = await openOn(COMMENTED - 5, ".inline-comment-composer");
		const barTop = m.innerHeight - 20 - 52;
		expect(m.widget!.bottom).toBeLessThanOrEqual(barTop);
		await closeAll();
	});

	it("stays above the on-screen keyboard", async () => {
		const m = await page.evaluate(async () => {
			const keyboardTop = 400;
			const real = window.visualViewport;
			Object.defineProperty(window, "visualViewport", {
				configurable: true,
				value: { width: window.innerWidth, height: keyboardTop, addEventListener: () => {}, removeEventListener: () => {} },
			});
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			plugin.openComposer((leaf.view.editor as unknown as { cm: unknown }).cm, 10);
			await new Promise((r) => setTimeout(r, 600));
			const bottom = (document.querySelector(".inline-comment-composer") as HTMLElement).getBoundingClientRect().bottom;
			plugin.composer.close();
			Object.defineProperty(window, "visualViewport", { configurable: true, value: real });
			return { bottom, keyboardTop, innerHeight: window.innerHeight };
		});
		expect(m.bottom).toBeLessThanOrEqual(m.keyboardTop);
		expect(m.innerHeight).toBeGreaterThan(m.keyboardTop);
	});

	it("moves above a keyboard Obsidian reports only through --keyboard-height (#159)", async () => {
		// Obsidian's Android app leaves visualViewport at full height and publishes
		// the keyboard on the root element, after the composer has already opened.
		await openOn(COMMENTED - 5, ".inline-comment-composer");
		const m = await page.evaluate(async () => {
			const bottom = () =>
				(document.querySelector(".inline-comment-composer") as HTMLElement).getBoundingClientRect().bottom;
			const before = bottom();
			document.documentElement.style.setProperty("--keyboard-height", "300px");
			await new Promise((r) => setTimeout(r, 300));
			const withKeyboard = bottom();
			document.documentElement.style.removeProperty("--keyboard-height");
			await new Promise((r) => setTimeout(r, 300));
			return {
				before,
				withKeyboard,
				after: bottom(),
				innerHeight: window.innerHeight,
				visual: window.visualViewport?.height,
			};
		});
		// Guard: the viewport really is untouched, as it is on Android.
		expect(m.visual).toBe(m.innerHeight);
		expect(Math.round(m.before)).toBe(m.innerHeight);
		expect(Math.round(m.withKeyboard)).toBe(m.innerHeight - 300);
		expect(Math.round(m.after)).toBe(m.innerHeight);
		await closeAll();
	});

	it("drops the navigation bar's reservation once the bar slides away (#160)", async () => {
		await page.evaluate(() => {
			const bar = document.body.createDiv({ cls: "mobile-navbar qa-fake" });
			Object.assign(bar.style, { position: "fixed", left: "0", right: "0", bottom: "20px", height: "52px" });
		});
		await openOn(COMMENTED - 5, ".inline-comment-composer");
		const m = await page.evaluate(async () => {
			const bottom = () =>
				(document.querySelector(".inline-comment-composer") as HTMLElement).getBoundingClientRect().bottom;
			const withBar = bottom();
			// As Obsidian hides it: a body class, and the bar moved just below the
			// screen, 2px past the edge as measured on a Pixel 8.
			(document.querySelector(".mobile-navbar.qa-fake") as HTMLElement).style.bottom = "-54px";
			document.body.addClass("is-hidden-nav");
			await new Promise((r) => setTimeout(r, 300));
			return { withBar, hidden: bottom(), innerHeight: window.innerHeight };
		});
		expect(m.withBar).toBeLessThanOrEqual(m.innerHeight - 20 - 52);
		expect(Math.round(m.hidden)).toBe(m.innerHeight);
		await closeAll();
	});

	it("is not a sheet when the flag is off", async () => {
		await page.evaluate(() => {
			window.app.plugins.plugins["margin-comments"].sheet = false;
		});
		const m = await openOn(COMMENTED - 5, ".inline-comment-composer");
		expect(m.placement).not.toBe("sheet");
		expect(m.widget!.right - m.widget!.left).toBeLessThan(m.innerWidth);
		await closeAll();
	});
});
