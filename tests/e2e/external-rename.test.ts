import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { renameSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import { hashString } from "../../src/utils";

const NOTE = "ext.md";
const RENAMED = "ext-renamed.md";
const BODY = ["alpha beta gamma", "delta epsilon"].join("\n");

// src/storage pulls in "obsidian", which this config does not alias.
const STORAGE_DIR = ".margin-comments";
const held = (vault: string, filePath: string) =>
	join(vault, STORAGE_DIR, "held", `${hashString(filePath)}.json`);
const sidecar = (vault: string, filePath: string) =>
	join(vault, STORAGE_DIR, `${hashString(filePath)}.json`);

/**
 * #259: renamed outside Obsidian, a note arrives as `create` for the new path and
 * then `delete` for the old one — never a `rename`. Under the default behaviour the
 * delete took the comments off disk, so they lived only in memory and were gone when
 * Obsidian closed.
 */
describe("a note renamed outside Obsidian", () => {
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

		await page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;
			const at = 0;
			await plugin.routing.createComment(cm, note, at, at + 5, "a comment that must survive");
		}, NOTE);
		await page.waitForTimeout(1200);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("hands them to the note it was renamed to", async () => {
		expect(existsSync(sidecar(vault.path, NOTE))).toBe(true);

		// Recorded as well as the outcome, because the whole design rests on the
		// order Obsidian reports: a create for the new path and then a delete for
		// the old one, never a rename (#259, #289). If that ever changes, this says
		// so instead of the pairing quietly never firing.
		const events: string[] = [];
		/* eslint-disable @typescript-eslint/no-explicit-any -- the vault event
		   payloads are not typed inside page.evaluate. */
		await page.evaluate(() => {
			(window as any).__ev = [];
			const push = (s: string) => (window as any).__ev.push(s);
			window.app.vault.on("create", (f: any) => push(`create ${f.path}`));
			window.app.vault.on("delete", (f: any) => push(`delete ${f.path}`));
			window.app.vault.on("rename", (f: any, o: string) => push(`rename ${o} -> ${f.path}`));
		});
		/* eslint-enable @typescript-eslint/no-explicit-any */

		// Outside Obsidian, as Finder, a terminal or a sync client would.
		renameSync(join(vault.path, NOTE), join(vault.path, RENAMED));

		// Polled on disk, because that is where the answer has to end up and the
		// watcher's timing is Obsidian's, not ours.
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline && !existsSync(sidecar(vault.path, RENAMED))) {
			await page.waitForTimeout(500);
		}
		events.push(...(await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev)));

		expect({ renamedSidecar: existsSync(sidecar(vault.path, RENAMED)), events }).toEqual({
			renamedSidecar: true,
			events: ["create ext-renamed.md", "delete ext.md"],
		});
		expect(existsSync(sidecar(vault.path, NOTE))).toBe(false);
		expect(existsSync(held(vault.path, NOTE))).toBe(false);
	});

	it("leaves them held when the note simply goes", async () => {
		// The other half of #259, which this must not have undone: a note deleted
		// with nothing created alongside it keeps its comments on disk rather than
		// losing them when Obsidian closes.
		const second = "second.md";
		writeFileSync(join(vault.path, second), "a second note, long enough to anchor against");
		await page.waitForTimeout(2500);
		await page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;
			await plugin.routing.createComment(cm, note, 0, 8, "a comment on the second note");
		}, second);
		await page.waitForTimeout(1500);

		unlinkSync(join(vault.path, second));

		// Polled on disk, like the test above. The wait this replaced asked for
		// `.notice` count >= 0, which is true before anything happens at all —
		// the three seconds after it were doing the work, and the condition read
		// like a guarantee it never made (audit, 2026-10-07).
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline && !existsSync(held(vault.path, second))) {
			await page.waitForTimeout(500);
		}

		expect(existsSync(held(vault.path, second))).toBe(true);
	});
});
