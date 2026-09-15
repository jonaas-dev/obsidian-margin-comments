import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

import { createAnchor } from "../../src/anchor";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";

const NOTE = "sync.md";
const OTHER = "other-device.md";
const BODY = ["first line", "second line", "third line"].join("\n");

function commentOn(id: string, filePath: string, words: string): Comment {
	const from = BODY.indexOf(words);
	return {
		id,
		filePath,
		anchor: createAnchor(BODY, from, from + words.length),
		content: `body of ${id}`,
		author: "",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

/**
 * The storage folder changing under a running plugin, written with Node's fs the way
 * a sync client (Git, iCloud, Dropbox, Syncthing) delivers another device's work (#260).
 */
describe("comments that arrive from another device", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const storageFile = (name: string): string => `${vault.path}/.margin-comments/${name}`;
	const sidecarFile = (notePath: string): string => storageFile(`${hashString(notePath)}.json`);
	const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
	const deliver = (path: string, value: unknown): void =>
		writeFileSync(path, JSON.stringify(value, null, 2));

	/** Saves through the plugin's own store, as the composer does. */
	async function saveHere(comment: Comment): Promise<void> {
		await page.evaluate(async (value: Comment) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			await plugin.storage.saveComment(value);
			await plugin.refresh();
		}, comment);
	}

	const shownIds = (): Promise<string[]> =>
		page.evaluate(async (path: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			return (await plugin.storage.getCommentsForFile(path)).map((c: Comment) => c.id);
		}, NOTE);

	const listedNotes = (): Promise<string[]> =>
		page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			return (await plugin.storage.getCommentSummaries()).map(
				(s: { filePath: string }) => s.filePath,
			);
		});

	const activeMarkers = (): Promise<number> =>
		page.locator(".workspace-leaf.mod-active .inline-comment-marker-active").count();

	/** Polls, because the change reaches the plugin through a file watcher. */
	async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
		const deadline = Date.now() + 8000;
		let value = await read();
		while (!done(value) && Date.now() < deadline) {
			await page.waitForTimeout(250);
			value = await read();
		}
		return value;
	}

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			if (!file) throw new Error(`no note at ${path}`);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);
		await saveHere(commentOn("local-1", NOTE, "second line"));
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("shows a comment added to the open note elsewhere, without a restart", async () => {
		expect(await activeMarkers()).toBe(1);

		const sidecar = readJson(sidecarFile(NOTE));
		sidecar.comments.push(commentOn("external-1", NOTE, "third line"));
		deliver(sidecarFile(NOTE), sidecar);

		expect(await eventually(shownIds, (ids) => ids.includes("external-1"))).toEqual([
			"local-1",
			"external-1",
		]);
		// The redraw, not just the store: a marker on the line the other device commented.
		expect(await eventually(activeMarkers, (count) => count === 2)).toBe(2);
	});

	it("lists a note commented elsewhere in the all-notes view", async () => {
		writeFileSync(`${vault.path}/${OTHER}`, BODY);
		deliver(sidecarFile(OTHER), {
			version: 1,
			filePath: OTHER,
			comments: [commentOn("other-1", OTHER, "first line")],
		});

		expect(await eventually(listedNotes, (notes) => notes.includes(OTHER))).toContain(OTHER);
	});

	it("keeps what arrived when this device writes next", async () => {
		const index = readJson(storageFile("_index.json"));
		index.notes[OTHER] = { hash: hashString(OTHER), threads: 1, open: 1 };
		deliver(storageFile("_index.json"), index);
		await page.waitForTimeout(1000);

		await saveHere(commentOn("local-2", NOTE, "first line"));

		expect(readJson(sidecarFile(NOTE)).comments.map((c: Comment) => c.id)).toEqual([
			"local-1",
			"external-1",
			"local-2",
		]);
		expect(Object.keys(readJson(storageFile("_index.json")).notes)).toContain(OTHER);
	});
});
