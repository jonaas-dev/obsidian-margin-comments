import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const REPO = fileURLToPath(new URL("../..", import.meta.url));

describe("a visible storage folder in the vault's own events", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	function commentsAt(dir: string, notePath: string): Comment[] {
		const path = `${vault.path}/${dir}/${hashString(notePath)}.json`;
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf8")).comments;
	}

	function storedSettings(): { storageFolder?: string } {
		return JSON.parse(readFileSync(`${REPO}/data.json`, "utf8"));
	}

	const noticeTexts = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".notice")).map(
				(n) => (n as HTMLElement).innerText,
			),
		);

	async function openNote(note: string): Promise<void> {
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			if (!file) throw new Error(`no note at ${path}`);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, note);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
	}

	async function addComment(line: number, text: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const box = await page.locator(".cm-line").nth(line).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(text);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}

	async function rename(from: string, to: string): Promise<void> {
		await page.evaluate(
			async ([source, target]: string[]) => {
				const file = window.app.vault.getAbstractFileByPath(source);
				if (!file) throw new Error(`nothing to rename at ${source}`);
				await window.app.fileManager.renameFile(file, target);
			},
			[from, to],
		);
		await page.waitForTimeout(1500);
	}

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		// After createTempVault, which deletes it: the plugin reads its settings from the repo.
		writeFileSync(`${REPO}/data.json`, JSON.stringify({ storageFolder: "margin-comments" }));
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		// Local trash, so trashFile does not reach the developer's system trash.
		await page.evaluate(() =>
			(window.app.vault as unknown as { setConfig(k: string, v: string): void }).setConfig(
				"trashOption",
				"local",
			),
		);
		await openNote(NOTE);
		await dismissModals(page);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
		rmSync(`${REPO}/data.json`, { force: true });
	});

	it("saves into the visible folder without a Notice from the vault events", async () => {
		const before = (await noticeTexts()).length;
		await addComment(1, "first comment");
		expect(commentsAt("margin-comments", NOTE)).toHaveLength(1);
		expect(await noticeTexts()).toHaveLength(before);
	});

	it("moves the sidecar when the note is renamed", async () => {
		await rename(NOTE, "notes/standup.md");
		expect(commentsAt("margin-comments", "notes/standup.md")).toHaveLength(1);
		expect(commentsAt("margin-comments", NOTE)).toHaveLength(0);
	});

	it("follows the folder when the user renames it", async () => {
		await rename("margin-comments", "comments-moved");
		expect(storedSettings().storageFolder).toBe("comments-moved");
		expect((await noticeTexts()).some((t) => t.includes("renamed to comments-moved"))).toBe(
			true,
		);

		await openNote("notes/standup.md");
		await addComment(2, "second comment");
		expect(commentsAt("comments-moved", "notes/standup.md")).toHaveLength(2);
		expect(existsSync(`${vault.path}/margin-comments`)).toBe(false);
	});

	it("keeps a Notice up and does not recreate the folder when it is deleted", async () => {
		await page.evaluate(async () => {
			const folder = window.app.vault.getAbstractFileByPath("comments-moved");
			if (!folder) throw new Error("no storage folder to delete");
			await window.app.fileManager.trashFile(folder);
		});
		// Past the default Notice timeout, so only a persistent one is still there.
		await page.waitForTimeout(7000);
		expect((await noticeTexts()).some((t) => t.includes("comments-moved was deleted"))).toBe(
			true,
		);
		expect(existsSync(`${vault.path}/comments-moved`)).toBe(false);

		await addComment(0, "after the delete");
		expect(commentsAt("comments-moved", "notes/standup.md").map((c) => c.content)).toEqual([
			"after the delete",
		]);
	});
});
