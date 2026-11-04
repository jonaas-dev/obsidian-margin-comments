import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

const NOTE = "meeting.md";
const BODY = ["first line", "second line", "third line"].join("\n");
const REPO = fileURLToPath(new URL("../..", import.meta.url));

function comment(id: string, content: string, updatedAt: number): Comment {
	return {
		id,
		filePath: NOTE,
		anchor: {
			selectedText: "",
			textHash: "",
			isLineComment: true,
			contextBefore: "",
			contextAfter: "",
			lineHint: 1,
			startOffset: 0,
			endOffset: 0,
		},
		content,
		author: "Tester",
		createdAt: 1,
		updatedAt,
		resolved: false,
		parentId: null,
	};
}

const sidecar = (comments: Comment[]): string =>
	JSON.stringify({ version: 1, filePath: NOTE, comments });
const SIDECAR = `${hashString(NOTE)}.json`;

describe("moving the comments to another storage folder", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const stored = (dir: string): Comment[] =>
		JSON.parse(readFileSync(`${vault.path}/${dir}/${SIDECAR}`, "utf8")).comments;
	const storedSettings = (): { storageFolder?: string } =>
		JSON.parse(readFileSync(`${REPO}/data.json`, "utf8"));
	const change = (to: string): Promise<void> =>
		page.evaluate(
			(target: string) => window.app.plugins.plugins["margin-comments"].changeStorageFolder(target),
			to,
		);
	const noticeTexts = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".notice")).map((n) => (n as HTMLElement).innerText),
		);

	beforeAll(async () => {
		vault = createTempVault({
			[NOTE]: BODY,
			[`.margin-comments/${SIDECAR}`]: sidecar([
				comment("c1", "newer in source", 200),
				comment("c2", "only in source", 100),
			]),
			// Pre-seeded target for the second case: overlaps on c1, which is older here.
			[`other/${SIDECAR}`]: sidecar([
				comment("c1", "older in target", 50),
				comment("c3", "only in target", 60),
			]),
		});
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
		await page.evaluate(() =>
			window.app.commands.executeCommandById("margin-comments:toggle-comments-panel"),
		);
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
		// The plugin directory is the repo, so its data.json outlives the vault.
		rmSync(`${REPO}/data.json`, { force: true });
	});

	it("moves the files, drops the hidden folder, saves the setting and keeps the threads", async () => {
		await change("margin-comments");
		await page.waitForTimeout(800);

		expect(stored("margin-comments").map((c) => c.id)).toEqual(["c1", "c2"]);
		expect(existsSync(`${vault.path}/.margin-comments`)).toBe(false);
		expect(storedSettings().storageFolder).toBe("margin-comments");
		expect(await page.locator(".inline-comment-card").count()).toBe(2);
		expect((await noticeTexts()).some((t) => t.includes("to margin-comments"))).toBe(true);
	});

	it("merges by comment id into a folder that already holds the note, keeping the newer copy", async () => {
		await change("other");
		await page.waitForTimeout(800);

		const merged = stored("other");
		expect(merged.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
		expect(merged.find((c) => c.id === "c1")).toMatchObject({
			content: "newer in source",
			updatedAt: 200,
		});
		expect(existsSync(`${vault.path}/margin-comments`)).toBe(false);
		expect(storedSettings().storageFolder).toBe("other");
	});

	it("rejects a nested name: nothing moves and data.json is unchanged", async () => {
		const before = readFileSync(`${REPO}/data.json`, "utf8");
		await change("a/b");
		await page.waitForTimeout(500);

		expect(readFileSync(`${REPO}/data.json`, "utf8")).toBe(before);
		expect(storedSettings().storageFolder).toBe("other");
		expect(stored("other")).toHaveLength(3);
		expect(existsSync(`${vault.path}/a`)).toBe(false);
		expect((await noticeTexts()).some((t) => t.includes("a/b cannot be a storage folder"))).toBe(
			true,
		);
	});
});
