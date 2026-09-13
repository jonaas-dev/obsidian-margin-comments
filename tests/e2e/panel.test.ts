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
		await enablePlugin(page, "margin-comments");
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
		const dir = `${vault.path}/.margin-comments`;
		const file = readdirSync(dir).find((f) => f !== "_index.json")!;
		return JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
	}

	it("opens from the ribbon command", async () => {
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
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
		// The send button rather than Enter: the harness cannot hold focus in a
		// textarea, so a keydown never reaches it. keyIntent covers that decision.
		await page.locator(".inline-comment-send").first().click();
		await page.waitForTimeout(1500);

		const { readdirSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const dir = join(vault.path, ".margin-comments");
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
		await page.locator('[aria-label="Edit comment"]').first().click();
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

	it("shows a filter segment per bucket, with counts matching the list", async () => {
		const counts = await page.locator(".inline-comment-filter-count").allInnerTexts();
		expect(counts).toEqual(["1", "1", "0"]);
		expect(await page.locator(".inline-comment-card").count()).toBe(1);
		expect(await page.locator(".inline-comment-filter.is-active").innerText()).toContain("All");
	});

	it("hides the thread under a filter it does not belong to", async () => {
		await page.locator(".inline-comment-filter", { hasText: "Resolved" }).click();
		await page.waitForTimeout(600);

		expect(await page.locator(".inline-comment-card").count()).toBe(0);
		// A message about this filter, not a generic "nothing here".
		expect(await page.locator(".inline-comment-empty").innerText()).toContain(
			"No resolved comments yet",
		);
	});

	it("keeps the chosen filter when the panel is closed and reopened", async () => {
		await page.locator('[aria-label="Close comments panel"]').click();
		await page.waitForTimeout(600);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });

		expect(await page.locator(".inline-comment-filter.is-active").innerText()).toContain(
			"Resolved",
		);
	});

	it("stores the filter in data.json, so it survives a restart", async () => {
		const { readFileSync } = await import("node:fs");
		const data = JSON.parse(
			readFileSync(`${vault.path}/.obsidian/plugins/margin-comments/data.json`, "utf8"),
		);
		expect(data.panelFilter).toBe("resolved");
	});

	it("drops the filter rather than hiding a thread the marker points at", async () => {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForTimeout(800);

		expect(await page.locator(".inline-comment-filter.is-active").innerText()).toContain("All");
		expect(await page.locator(".inline-comment-card.is-selected").count()).toBe(1);
	});

	it("selects the thread in the panel when its marker is clicked", async () => {
		// Clicking a marker asks "which comment is this?" — the panel has to answer.
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForTimeout(800);

		expect(await page.locator(".inline-comment-card.is-selected").count()).toBe(1);
		// With the panel open there is no popover: everything stays in one place.
		expect(await page.locator(".inline-comment-popover").count()).toBe(0);
	});

	it("closes from the panel's own close button", async () => {
		await page.locator('[aria-label="Close comments panel"]').click();
		await page.waitForTimeout(600);
		expect(await page.locator(".inline-comment-panel").count()).toBe(0);
	});

	it("opens a popover beside the line when the panel is closed", async () => {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(1).boundingBox();
		await page.mouse.click(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForSelector(".inline-comment-popover", { timeout: 5000 });

		expect(await page.locator(".inline-comment-popover .inline-comment-body").count()).toBeGreaterThan(0);
		// Beside the line, not over it.
		const box = await page.locator(".inline-comment-popover").boundingBox();
		expect(box.x).toBeGreaterThan(gutters.x);
	});

	it("closes the popover with Escape", async () => {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(400);
		expect(await page.locator(".inline-comment-popover").count()).toBe(0);
	});

	it("asks before deleting and names how many replies go with it", async () => {
		// The popover tests above close the panel; the delete actions live in it.
		await page.evaluate(async () => {
			if (window.app.workspace.getLeavesOfType("margin-comments-panel").length === 0) {
				await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
			}
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });

		await page.locator(".inline-comment-card").first().hover();
		await page.locator('[aria-label="Delete comment"]').first().click();
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
		await page.locator('[aria-label="Delete comment"]').first().click();
		await page.waitForSelector(".modal", { timeout: 5000 });
		await page.locator(".modal button", { hasText: "Delete" }).click();
		await page.waitForTimeout(1500);

		// Last comment gone means the sidecar itself should be gone, not left empty.
		const dir = `${vault.path}/.margin-comments`;
		expect(readdirSync(dir).filter((f) => f !== "_index.json")).toHaveLength(0);
		expect(await page.locator(".inline-comment-active-line").count()).toBe(0);
		expect(await page.locator(".inline-comment-empty").count()).toBe(1);
	});

});
