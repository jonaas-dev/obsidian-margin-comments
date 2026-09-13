import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const OTHER = "other.md";
const ANCHOR_LINE = "the paragraph this comment is attached to";
const BODY = ["first line", ANCHOR_LINE, "third line"].join("\n");
/** Shares no words and no context with BODY, so all three stages must fail. */
const REWRITTEN = ["nothing", "whatsoever", "remains"].join("\n");

describe("orphaned comments", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function openNote(note: string): Promise<void> {
		// The active leaf, never a new tab: a second tab leaves the first note's
		// editor in the DOM but hidden, and .cm-editor goes on matching it.
		await page.evaluate(async (path: string) => {
			const file = window.app.vault.getAbstractFileByPath(path);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, note);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
	}

	async function setNoteText(text: string): Promise<void> {
		await page.evaluate((value: string) => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			leaf.view.editor.setValue(value);
		}, text);
		await page.waitForTimeout(1500);
	}

	/** Wait out the notice timeout, so a later count of zero means something. */
	async function letNoticesFade(): Promise<void> {
		await page.waitForFunction(() => document.querySelectorAll(".notice").length === 0, {
			timeout: 15000,
		});
	}

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY, [OTHER]: "an unrelated note" });
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
		await page.locator(".inline-comment-composer-input").fill("a comment worth keeping");
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1500);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("draws the comment normally while its text is there", async () => {
		await page.waitForSelector(".inline-comment-card", { timeout: 10000 });
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(0);
	});

	it("marks the card orphaned once the anchored text is gone", async () => {
		await letNoticesFade();
		await setNoteText(REWRITTEN);
		await page.waitForSelector(".inline-comment-card.is-orphaned", { timeout: 10000 });
		expect(await page.locator(".inline-comment-card.is-orphaned").count()).toBe(1);
	});

	it("still shows the text the comment was written against", async () => {
		expect(await page.locator(".inline-comment-quote").first().innerText()).toContain(
			ANCHOR_LINE,
		);
	});

	it("explains what happened, naming the note and the line", async () => {
		const reason = await page.locator(".inline-comment-orphan-reason").first().innerText();
		expect(reason).toContain("not found in note");
		expect(reason).toContain("line 2");
	});

	it("announces the loss once, without pointing to the panel already open (#143)", async () => {
		// The panel is on screen for this whole suite, so the pointer to it has to
		// be left out: this is what proves the visibility reaches the notice.
		const notice = await page.locator(".notice").last().innerText();
		expect(notice).toContain("lost its anchor");
		expect(notice).not.toContain("Open the comments panel");
	});

	it("stays quiet on later notes, which is the whole point of once per session", async () => {
		await letNoticesFade();
		await openNote(OTHER);
		await page.waitForTimeout(1500);
		await openNote(NOTE);
		await page.waitForTimeout(1500);
		expect(await page.locator(".notice").count()).toBe(0);
	});

	it("leaves the comment out of navigation instead of jumping nowhere", async () => {
		await page.evaluate(() => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			leaf.view.editor.setCursor({ line: 0, ch: 0 });
			leaf.view.editor.focus();
		});
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:next-comment");
		});
		await page.waitForTimeout(700);
		expect(await page.locator(".notice").last().innerText()).toContain(
			"No comments in this note",
		);
	});

	it("re-anchors by itself when the text comes back", async () => {
		// The acceptance criterion: the stored anchor was never rewritten while
		// the text was missing, so restoring it is all the recovery there is.
		await setNoteText(BODY);
		await page.waitForFunction(
			() => document.querySelectorAll(".inline-comment-card.is-orphaned").length === 0,
			{ timeout: 10000 },
		);
		expect(await page.locator(".inline-comment-card").count()).toBe(1);
		expect(await page.locator(".inline-comment-orphan-reason").count()).toBe(0);
	});
});
