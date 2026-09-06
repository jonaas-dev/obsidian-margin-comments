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
const KEEPER = "notes/keeper.md";
const BODY = ["first line", "the line that carries the comment", "third line"].join("\n");

describe("notes that are deleted", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function openNote(note: string): Promise<void> {
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			if (!file) throw new Error(`no note at ${path}`);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, note);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
	}

	async function commentOnSecondLine(body: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(body);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}

	/** Delete through the trash, which is what Obsidian's own UI does. */
	async function trash(notePath: string): Promise<void> {
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			if (!file) throw new Error(`nothing to delete at ${path}`);
			await window.app.vault.trash(file, false);
		}, notePath);
		await page.waitForTimeout(1500);
	}

	async function recreate(notePath: string, content: string): Promise<void> {
		await page.evaluate(
			async ([path, body]: string[]) => {
				await window.app.vault.create(path, body);
			},
			[notePath, content],
		);
		await page.waitForTimeout(1500);
	}

	function commentsAt(notePath: string): Comment[] {
		const path = `${vault.path}/.inline-comments/${hashString(notePath)}.json`;
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf8")).comments;
	}

	function indexPaths(): string[] {
		const raw = readFileSync(`${vault.path}/.inline-comments/_index.json`, "utf8");
		return Object.keys(JSON.parse(raw));
	}

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY, [KEEPER]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "inline-comments");
		await openNote(NOTE);
		await dismissModals(page);
		await commentOnSecondLine("a comment on a note about to go");

		await openNote(KEEPER);
		await commentOnSecondLine("a comment on a note that stays");
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("stores both notes' comments to begin with", () => {
		expect(commentsAt(NOTE)).toHaveLength(1);
		expect(indexPaths().sort()).toEqual([KEEPER, NOTE]);
	});

	it("takes the comments with the note", async () => {
		await trash(NOTE);
		expect(commentsAt(NOTE)).toEqual([]);
		expect(indexPaths()).toEqual([KEEPER]);
	});

	it("leaves every other note alone", () => {
		// A delete handler that clears more than the note it was given is the
		// worst possible bug here, and nothing in the note's own assertions
		// would catch it.
		expect(commentsAt(KEEPER)).toHaveLength(1);
	});

	it("says how many went, rather than removing them in silence", async () => {
		expect(await page.locator(".notice").last().innerText()).toContain("1 comment removed");
	});

	it("brings them back when the note comes back", async () => {
		await recreate(NOTE, BODY);
		expect(commentsAt(NOTE)).toHaveLength(1);
		expect(indexPaths().sort()).toEqual([KEEPER, NOTE]);
	});

	it("says so when they come back", async () => {
		expect(await page.locator(".notice").last().innerText()).toContain("1 comment restored");
	});

	it("shows the restored comment anchored, not orphaned", async () => {
		await openNote(NOTE);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-card", { timeout: 10000 });
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(0);
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"a comment on a note about to go",
		);
	});

	it("leaves the sidecar behind when the setting says keep", async () => {
		// Proves the branch is not dead: with no settings tab yet (#25) this is
		// the only way the alternative gets exercised at all.
		await recreate("notes/kept.md", BODY);
		await openNote("notes/kept.md");
		await commentOnSecondLine("a comment that outlives its note");
		expect(commentsAt("notes/kept.md")).toHaveLength(1);

		await page.evaluate(() => {
			window.app.plugins.plugins["inline-comments"].settings.orphanedBehavior = "keep";
		});
		await trash("notes/kept.md");

		expect(commentsAt("notes/kept.md")).toHaveLength(1);
		expect(indexPaths()).toContain("notes/kept.md");

		await page.evaluate(() => {
			window.app.plugins.plugins["inline-comments"].settings.orphanedBehavior = "delete";
		});
	});

	it("does not hand a dead note's comments to a different note made later", async () => {
		// The bin holds by path and must stop holding once it has paid out;
		// otherwise a new note written at a reused path inherits them.
		await trash(NOTE);
		await recreate(NOTE, BODY);
		await recreate("notes/unrelated.md", "nothing to do with any of this");
		expect(commentsAt("notes/unrelated.md")).toEqual([]);
		expect(commentsAt(NOTE)).toHaveLength(1);
	});
});
