import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

import type { Comment } from "../../src/types";

const NOTE = "note.md";
const EMPTY_NOTE = "empty.md";
const BODY = ["first line", "second line", "third line", "fourth line", "fifth line"].join("\n");

describe("commands", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function openNote(note: string): Promise<void> {
		// The active leaf rather than a new tab: a second tab leaves the first
		// note's editor in the DOM but hidden, and every selector here would go on
		// matching it.
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, note);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
	}

	/** The editor showing `note`, whichever leaf holds it. */
	async function run(command: string): Promise<void> {
		await page.evaluate(async (id: string) => {
			await window.app.commands.executeCommandById(id);
		}, `margin-comments:${command}`);
		await page.waitForTimeout(700);
	}

	async function setCursorLine(line: number): Promise<void> {
		await page.evaluate((index: number) => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			leaf.view.editor.setCursor({ line: index, ch: 0 });
			leaf.view.editor.focus();
		}, line);
	}

	const cursorLine = (): Promise<number> =>
		page.evaluate(() => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			return leaf.view.editor.getCursor().line;
		});

	async function commentOnLine(index: number, body: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(index).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(body);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1200);
	}

	function readSidecar(): { comments: Comment[] } {
		const dir = `${vault.path}/.margin-comments`;
		const file = readdirSync(dir).find((f) => f !== "_index.json")!;
		return JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
	}

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY, [EMPTY_NOTE]: "nothing commented here" });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await openNote(NOTE);
		await dismissModals(page);

		await commentOnLine(0, "comment on the first line");
		await commentOnLine(4, "comment on the fifth line");
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("ships no default hotkey for adding a comment", async () => {
		// #122: Obsidian's plugin guidelines ask plugins not to bind keys by
		// default. Read from defaultKeys, which only a registration can fill.
		const hotkeys = await page.evaluate(
			() => window.app.hotkeyManager.defaultKeys["margin-comments:add-comment"] ?? [],
		);
		expect(hotkeys).toEqual([]);
	});

	it("opens the composer from the add-comment command", async () => {
		await setCursorLine(2);
		await run("add-comment");
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		// Cancel rather than Escape: the harness cannot hold focus in a textarea,
		// so a keydown never reaches the composer. keyIntent covers that decision.
		await page.locator(".inline-comment-composer button", { hasText: "Cancel" }).click();
		await page.waitForTimeout(400);
		expect(await page.locator(".inline-comment-composer").count()).toBe(0);
	});

	it("jumps forward to the next commented line", async () => {
		await setCursorLine(0);
		await run("next-comment");
		expect(await cursorLine()).toBe(4);
	});

	it("wraps to the first comment rather than stopping at the last", async () => {
		await run("next-comment");
		expect(await cursorLine()).toBe(0);
	});

	it("jumps backwards, wrapping the other way", async () => {
		await run("previous-comment");
		expect(await cursorLine()).toBe(4);
	});

	it("says so in a note with no comments instead of moving the cursor", async () => {
		await openNote(EMPTY_NOTE);
		await setCursorLine(0);
		await run("next-comment");

		expect(await page.locator(".notice").innerText()).toContain("No comments in this note");
		expect(await cursorLine()).toBe(0);
	});

	it("names how many threads resolve-all covers, and resolves them", async () => {
		await openNote(NOTE);
		await run("resolve-all-comments");
		await page.waitForSelector(".modal", { timeout: 5000 });
		expect(await page.locator(".modal-title").innerText()).toBe(
			"Resolve 2 open threads in this note?",
		);
		// Resolving is reversible, so the dialog must not claim otherwise.
		expect(await page.locator(".inline-comment-confirm-note").innerText()).toContain(
			"can be reopened",
		);

		await page.locator(".modal button", { hasText: "Resolve" }).click();
		await page.waitForTimeout(1500);

		const roots = readSidecar().comments.filter((c: Comment) => c.parentId === null);
		expect(roots).toHaveLength(2);
		expect(roots.every((c: Comment) => c.resolved)).toBe(true);
		expect(await page.locator(".inline-comment-active-line").count()).toBe(0);
	});

	it("does not open a dialog when nothing is open to resolve", async () => {
		await run("resolve-all-comments");
		expect(await page.locator(".modal").count()).toBe(0);
		// The last one: an earlier notice from this run may not have faded yet.
		expect(await page.locator(".notice").last().innerText()).toContain(
			"No open comments in this note",
		);
	});

	it("scopes the note commands to an editor, so they cannot run without one", async () => {
		// Asserted on the registration rather than on a return value:
		// executeCommandById answers true here even with every note closed, so a
		// test built on it would pass whatever the command is bound to.
		const shapes = await page.evaluate(() =>
			["add-comment", "next-comment", "previous-comment", "resolve-all-comments"].map(
				(id: string) => {
					const command = window.app.commands.commands[`margin-comments:${id}`];
					return {
						editorScoped: typeof command.editorCallback === "function",
						global: typeof command.callback === "function",
					};
				},
			),
		);
		expect(shapes).toEqual([
			{ editorScoped: true, global: false },
			{ editorScoped: true, global: false },
			{ editorScoped: true, global: false },
			{ editorScoped: true, global: false },
		]);
		// The panel toggle is the one command that must work anywhere.
		expect(
			await page.evaluate(
				() =>
					typeof window.app.commands.commands["margin-comments:toggle-comments-panel"].callback,
			),
		).toBe("function");
	});

	it("survives running a note command with every note closed", async () => {
		// Last in the file, since it closes every note.
		await page.evaluate(() => window.app.workspace.detachLeavesOfType("markdown"));
		await page.waitForTimeout(800);
		await run("resolve-all-comments");
		expect(await page.locator(".modal").count()).toBe(0);
	});
});
