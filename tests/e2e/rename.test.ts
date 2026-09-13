import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";

const NOTE = "notes/meeting.md";
const BODY = ["first line", "the line that carries the comment", "third line"].join("\n");

describe("notes that move", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function openNote(note: string): Promise<void> {
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			// Throws rather than opening nothing: openFile(null) leaves the previous
			// note on screen and every selector below goes on matching it, which is
			// a test passing because the vault never changed.
			if (!file) throw new Error(`no note at ${path}`);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, note);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
	}

	const activePath = (): Promise<string> =>
		page.evaluate(() => window.app.workspace.getActiveFile()?.path);

	/**
	 * Rename through fileManager, the path Obsidian's own UI takes.
	 *
	 * The destination folder is created first: renameFile does not make one, and
	 * the ENOENT it throws instead reads as a plugin failure.
	 */
	async function rename(from: string, to: string): Promise<void> {
		await page.evaluate(
			async ([source, target]: string[]) => {
				const folder = target.split("/").slice(0, -1).join("/");
				if (folder && !window.app.vault.getAbstractFileByPath(folder)) {
					await window.app.vault.createFolder(folder);
				}
				const file = window.app.vault.getAbstractFileByPath(source);
				if (!file) throw new Error(`nothing to rename at ${source}`);
				await window.app.fileManager.renameFile(file, target);
			},
			[from, to],
		);
		await page.waitForTimeout(1500);
	}

	/** The sidecar a path would own, read straight off disk. */
	function sidecarPath(notePath: string): string {
		return `${vault.path}/.margin-comments/${hashString(notePath)}.json`;
	}

	function commentsAt(notePath: string): Comment[] {
		const path = sidecarPath(notePath);
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf8")).comments;
	}

	function indexPaths(): string[] {
		const raw = readFileSync(`${vault.path}/.margin-comments/_index.json`, "utf8");
		return Object.keys(JSON.parse(raw));
	}

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await openNote(NOTE);
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
		await page.locator(".inline-comment-composer-input").fill("a comment that must follow");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("stores the comment against the note it was written on", () => {
		expect(commentsAt(NOTE)).toHaveLength(1);
	});

	it("carries the comment to the renamed note", async () => {
		await rename(NOTE, "notes/standup.md");
		expect(commentsAt("notes/standup.md")).toHaveLength(1);
		expect(commentsAt(NOTE)).toHaveLength(0);
	});

	it("rewrites filePath, which is what a rebuilt index reads", () => {
		expect(commentsAt("notes/standup.md")[0].filePath).toBe("notes/standup.md");
	});

	it("keeps the all-notes view pointing at the note that exists", () => {
		expect(indexPaths()).toEqual(["notes/standup.md"]);
	});

	it("shows the comment attached, not orphaned, on reopening", async () => {
		await openNote("notes/standup.md");
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-card", { timeout: 10000 });
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(0);
		expect(await page.locator(".inline-comment-quote").first().innerText()).toContain(
			"the line that carries the comment",
		);
	});

	it("follows the note into another folder", async () => {
		await rename("notes/standup.md", "archive/standup.md");
		expect(commentsAt("archive/standup.md")).toHaveLength(1);
		expect(indexPaths()).toEqual(["archive/standup.md"]);
	});

	it("follows every note under a renamed folder, exactly once", async () => {
		// Obsidian emits the folder rename and one for every descendant, so the
		// same note is handled twice. The length assertion is the point: two
		// handlers reading the index before either writes lands the thread twice.
		await rename("archive", "2026");
		expect(commentsAt("2026/standup.md")).toHaveLength(1);
		expect(indexPaths()).toEqual(["2026/standup.md"]);
	});

	it("is still readable in the editor after all of it", async () => {
		await openNote("2026/standup.md");
		// Named explicitly: the panel keeps its cards on screen across a note
		// switch, so asserting on a card alone would pass without this note ever
		// having been opened.
		expect(await activePath()).toBe("2026/standup.md");
		await page.waitForSelector(".inline-comment-card", { timeout: 10000 });
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(0);
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"a comment that must follow",
		);
	});
});
