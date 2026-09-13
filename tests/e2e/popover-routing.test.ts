import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { toString(): string } };
	dispatch(spec: unknown): void;
}

const NOTE = "note.md";
const BODY = ["alpha beta gamma on the first line", "delta epsilon on the second line"].join("\n");

/**
 * Where activating a commented line sends the reader, and what the popover
 * then does with the threads it shows.
 *
 * #137: every open thread on the line, not the first.
 * #133: an action taken in the popover shows up in the popover.
 * #125: the panel answers only when it is actually on screen.
 * #129: a panel leaf that has not been shown yet does not break a refresh.
 */
describe("routing a marker activation", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Select `text` (or nothing), then activate `line`, as the gutter does. */
	async function activate(line: number, text: string | null = null): Promise<void> {
		await page.evaluate(
			async ([at, needle]: [number, string | null]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const doc = cm.state.doc.toString();
				const start = needle === null ? 0 : doc.indexOf(needle);
				const end = needle === null ? 0 : start + needle.length;
				cm.dispatch({ selection: { anchor: start, head: end } });
				plugin.routing.open(cm, at);
			},
			[line, text],
		);
		await page.waitForTimeout(800);
	}

	const popoverQuotes = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-popover .inline-comment-quote-text")).map(
				(q) => q.textContent,
			),
		);

	const selectedCards = (): Promise<number> =>
		page.evaluate(() => document.querySelectorAll(".inline-comment-panel .inline-comment-card.is-selected").length);

	async function closeAll(): Promise<void> {
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.popover?.close();
			plugin.routing.close();
		});
		await page.waitForTimeout(300);
	}

	async function reopenAll(): Promise<void> {
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			for (const c of await plugin.storage.getCommentsForFile("note.md")) {
				if (c.parentId === null && c.resolved) await plugin.setResolved(c, false);
			}
		});
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
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const doc = cm.state.doc.toString();
			// Created out of document order, so document order has to be imposed.
			for (const word of ["gamma", "beta", "epsilon"]) {
				const at = doc.indexOf(word);
				await plugin.routing.createComment(cm, leaf.view.file.path, at, at + word.length, `On ${word}.`);
			}
		});
		await page.waitForTimeout(1200);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("shows every open thread on the line, in document order (#137)", async () => {
		await activate(1);
		expect(await popoverQuotes()).toEqual(["beta", "gamma"]);
		await closeAll();
	});

	it("shows only the thread a selection covers (#75)", async () => {
		await activate(1, "gamma");
		expect(await popoverQuotes()).toEqual(["gamma"]);
		await closeAll();
	});

	it("redraws the popover without the thread just resolved (#133)", async () => {
		// The report: the thread was resolved on disk and the popover went on
		// showing it unchanged, so nothing said the tap had worked.
		await activate(1);
		await page.locator('.inline-comment-popover [aria-label="Resolve"]').first().click();
		await page.waitForTimeout(1200);
		expect(await popoverQuotes()).toEqual(["gamma"]);
	});

	it("closes the popover once the line has no open thread left (#133)", async () => {
		await page.locator('.inline-comment-popover [aria-label="Resolve"]').first().click();
		await page.waitForTimeout(1200);
		expect(await page.locator(".inline-comment-popover").count()).toBe(0);
		await reopenAll();
	});

	it("opens the popover when the panel exists but its sidebar is collapsed (#125)", async () => {
		// The report: the card was selected inside a drawer nobody could see, and
		// the popover was skipped because a panel leaf existed.
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		await page.evaluate(() => window.app.workspace.rightSplit.collapse());
		await page.waitForTimeout(600);

		await activate(2);
		expect(await popoverQuotes()).toEqual(["epsilon"]);
		expect(await selectedCards()).toBe(0);
		await closeAll();
	});

	it("still answers in the panel when the panel is on screen", async () => {
		await page.evaluate(() => window.app.workspace.rightSplit.expand());
		await page.waitForTimeout(600);

		await activate(2);
		expect(await page.locator(".inline-comment-popover").count()).toBe(0);
		expect(await selectedCards()).toBe(1);
	});

	it("creates a comment while the panel leaf is still deferred (#129)", async () => {
		const result = await page.evaluate(async () => {
			const ws = window.app.workspace;
			ws.rightSplit.collapse();
			// Reloading the layout is what leaves an unshown leaf deferred, as a
			// restart does.
			await ws.changeLayout(ws.getLayout());
			await new Promise((r) => setTimeout(r, 1200));
			const deferred = ws.getLeavesOfType("margin-comments-panel").map((l: { isDeferred: boolean }) => l.isDeferred);

			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = ws.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("delta");
			let outcome = "resolved";
			try {
				await plugin.routing.createComment(cm, leaf.view.file.path, at, at + 5, "Written while deferred.");
			} catch (error) {
				outcome = String(error);
			}
			const stored = (await plugin.storage.getCommentsForFile("note.md")).some(
				(c: { content: string }) => c.content === "Written while deferred.",
			);
			return { deferred, outcome, stored };
		});

		// Without a deferred leaf this would pass against any build.
		expect(result.deferred).toEqual([true]);
		expect(result.stored).toBe(true);
		expect(result.outcome).toBe("resolved");
	});
});
