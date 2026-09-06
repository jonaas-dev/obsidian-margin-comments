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
const BODY = ["first line of the note", "second line of the note", "third line"].join("\n");

describe("comment panel", () => {
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
		await enablePlugin(page, "inline-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(true).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".cm-editor", { timeout: 30000 });
		await dismissModals(page);

		// Create a comment through the UI so the panel reads real stored data.
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("**bold** comment body");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	function readSidecar(): { comments: Comment[] } {
		const dir = `${vault.path}/.inline-comments`;
		const file = readdirSync(dir).find((f) => f !== "_index.json")!;
		return JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
	}

	it("opens from the ribbon command", async () => {
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		expect(await page.locator(".inline-comment-panel").count()).toBe(1);
	});

	it("shows the comment body, which was unreadable before the panel existed", async () => {
		await page.waitForSelector(".inline-comment-body", { timeout: 10000 });
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"bold comment body",
		);
	});

	it("renders the body as Markdown rather than raw text", async () => {
		expect(await page.locator(".inline-comment-body strong").count()).toBeGreaterThan(0);
	});

	it("quotes the commented text so the card is identifiable", async () => {
		expect(await page.locator(".inline-comment-quote").first().innerText()).toContain(
			"second line of the note",
		);
	});

	it("adds a reply through the panel and stores it against the root", async () => {
		// The reply field is revealed by hovering the card, as a person would.
		await page.locator(".inline-comment-card").first().hover();
		const replyInput = page.locator(".inline-comment-replybox-input").first();
		await replyInput.click();
		await replyInput.fill("a reply from the test");
		await page.locator(".inline-comment-send").first().click();
		await page.waitForTimeout(1500);

		const { readdirSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const dir = join(vault.path, ".inline-comments");
		const file = readdirSync(dir).find((f) => f !== "_index.json")!;
		const sidecar = JSON.parse(readFileSync(join(dir, file), "utf8"));

		expect(sidecar.comments).toHaveLength(2);
		const root = sidecar.comments.find((c: { parentId: string | null }) => c.parentId === null);
		const reply = sidecar.comments.find((c: { parentId: string | null }) => c.parentId !== null);
		expect(reply.parentId).toBe(root.id);
		expect(reply.content).toBe("a reply from the test");
		// The reply carries the root's anchor rather than one of its own.
		expect(reply.anchor).toEqual(root.anchor);
	});

	it("does not navigate when the reply button is pressed", async () => {
		// The card jumps to the anchor on click and the button sits inside it, so
		// without stopPropagation pressing Reply also moves the cursor and pulls
		// focus into the editor, away from the composer that just opened.
		await page.evaluate(() => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			leaf.view.editor.setCursor({ line: 0, ch: 0 });
		});

		await page.locator(".inline-comment-card").first().hover();
		await page.locator(".inline-comment-replybox-input").first().click();
		await page.waitForTimeout(300);

		const cursorLine = await page.evaluate(() => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			return leaf.view.editor.getCursor().line;
		});
		expect(cursorLine).toBe(0);

	});

	it("shows the reply nested under its root with a count", async () => {
		await page.waitForSelector(".inline-comment-reply", { timeout: 10000 });
		expect(await page.locator(".inline-comment-reply").count()).toBe(1);
	});

	it("edits a comment in place and persists the new body", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Edit"]').first().click();
		await page.waitForSelector(".inline-comment-editor", { timeout: 5000 });
		const textarea = page.locator(".inline-comment-editor-input");
		await textarea.click();
		await textarea.fill("an edited body");
		await page.locator('[aria-label="Save changes"]').first().click();
		await page.waitForTimeout(1500);

		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			"an edited body",
		);
		const stored = readSidecar();
		const root = stored.comments.find((c: Comment) => c.parentId === null)!;
		expect(root.content).toBe("an edited body");
		expect(root.updatedAt).toBeGreaterThan(root.createdAt);
	});

	it("marks the edited comment as edited", async () => {
		expect(await page.locator(".inline-comment-edited").count()).toBeGreaterThan(0);
	});

	it("resolves a thread, which clears the line highlight", async () => {
		expect(await page.locator(".inline-comment-active-line").count()).toBe(1);
		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Resolve"], [aria-label="Reopen"]').first().click();
		await page.waitForTimeout(1500);

		expect(readSidecar().comments.find((c: Comment) => c.parentId === null)!.resolved).toBe(true);
		expect(await page.locator(".inline-comment-active-line").count()).toBe(0);
	});

	it("reopens a resolved thread and brings the highlight back", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Resolve"], [aria-label="Reopen"]').first().click();
		await page.waitForTimeout(1500);

		expect(readSidecar().comments.find((c: Comment) => c.parentId === null)!.resolved).toBe(false);
		expect(await page.locator(".inline-comment-active-line").count()).toBe(1);
	});

	it("asks before deleting and names how many replies go with it", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Delete"]').first().click();
		await page.waitForSelector(".modal", { timeout: 5000 });
		expect(await page.locator(".modal-title").innerText()).toBe(
			"Delete this comment and its 1 reply?",
		);
	});

	it("keeps the comment when the dialog is cancelled", async () => {
		const before = readSidecar().comments.length;
		await page.locator(".modal button", { hasText: "Cancel" }).click();
		await page.waitForTimeout(800);
		expect(readSidecar().comments).toHaveLength(before);
		expect(await page.locator(".modal").count()).toBe(0);
	});

	it("deletes the root together with its replies and removes the sidecar", async () => {
		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Delete"]').first().click();
		await page.waitForSelector(".modal", { timeout: 5000 });
		await page.locator(".modal button", { hasText: "Delete" }).click();
		await page.waitForTimeout(1500);

		// Last comment gone means the sidecar itself should be gone, not left empty.
		const dir = `${vault.path}/.inline-comments`;
		expect(readdirSync(dir).filter((f) => f !== "_index.json")).toHaveLength(0);
		expect(await page.locator(".inline-comment-active-line").count()).toBe(0);
		expect(await page.locator(".inline-comment-empty").count()).toBe(1);
	});

	it("shows the comments when the gutter marker of a commented line is clicked", async () => {
		// The gap reported from real use: clicking a marked line opened an empty
		// composer instead of showing what was already there. Re-created here
		// because the delete tests above leave the note with no comments.
		const gutters0 = await page.locator(".cm-gutters").boundingBox();
		const line0 = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.move(gutters0.x + gutters0.width / 2, line0.y + line0.height / 2);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(gutters0.x + gutters0.width / 2, line0.y + line0.height / 2);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill("recreated for this test");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);

		await page.evaluate(() => window.app.workspace.detachLeavesOfType("inline-comments-panel"));
		await page.waitForTimeout(300);
		expect(await page.locator(".inline-comment-panel").count()).toBe(0);

		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);

		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		expect(await page.locator(".inline-comment-composer").count()).toBe(0);
		// Assert against what is stored rather than a literal: earlier tests in
		// this file edit the body, and hardcoding it couples them by order.
		const stored = readSidecar().comments.find((c: Comment) => c.parentId === null)!;
		expect(await page.locator(".inline-comment-body").first().innerText()).toContain(
			stored.content,
		);
	});
});
