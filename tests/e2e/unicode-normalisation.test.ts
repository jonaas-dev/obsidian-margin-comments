import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

interface EditorViewLike {
	state: { doc: { toString(): string } };
}

const NOTE = "acentos.md";
// Written in NFD: "e" followed by a combining acute, which is what macOS has
// produced for decades. It draws as "e-acute" and compares unequal to the NFC one.
const WORD = "Cafe\u0301";
const COMPOSED = "Caf\u00e9";
const BODY = [
	`${WORD} con leche, y una conversacion larga sobre nada en particular.`,
	"",
	"Segunda linea, para que el contexto tenga de donde agarrarse.",
].join("\n");

/**
 * #320: a sync client, a second device or an editor rewrites the note in the
 * other Unicode normal form. Nothing a reader can see changes -- the word draws
 * identically -- but every comment on an accented word compared unequal and was
 * reported orphaned at the default tolerance.
 *
 * Driven end to end because the unit tests cover `matchAnchor` in isolation, and
 * what this asserts is that the anchor a real comment stored, through a real
 * sidecar, survives the round trip.
 */
describe("a note rewritten in the other Unicode normal form", () => {
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

		await page.evaluate(
			async ([note, word]: [string, string]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const at = cm.state.doc.toString().indexOf(word);
				await plugin.routing.createComment(cm, note, at, at + word.length, "sobre la palabra acentuada");
			},
			[NOTE, WORD],
		);
		await page.waitForTimeout(1200);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", { timeout: 10000 });
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("is not orphaned, and the panel still shows its card", async () => {
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(0);

		const path = join(vault.path, NOTE);
		const before = readFileSync(path, "utf8");
		expect(before.normalize("NFC")).not.toBe(before);

		// What a sync client does on the way through, written with Node's fs so
		// Obsidian sees it arrive from outside exactly as it would in the wild.
		writeFileSync(path, before.normalize("NFC"));
		await page.waitForTimeout(3000);

		const state = await page.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile(note);
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			return { count: comments.length, doc: cm.state.doc.toString() };
		}, NOTE);

		// The note really is in the other form now, and the comment is still stored.
		expect(state.doc.includes(COMPOSED)).toBe(true);
		expect(state.doc.includes(WORD)).toBe(false);
		expect(state.count).toBe(1);

		// Asserted on what the panel decided, which is where "orphaned" is computed
		// and where the user would have been told the text was gone.
		expect(await page.locator(".inline-comment-card").count()).toBe(1);
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(0);
	});
});
