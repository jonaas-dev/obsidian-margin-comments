import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

const NOTE = "note.md";
const LINKED = "around [[#The last section|a link]] carry";
const BODY = [
	"A paragraph with a commented phrase in it.",
	"",
	"```js",
	"const answer = 42;",
	"```",
	"",
	`Words ${LINKED} a comment too.`,
	"",
	"## The last section",
	"",
	"The end.",
].join("\n");

type Shown = { bodies: string[]; placement: string | null } | null;

/**
 * #171: reading mode painted each comment's words but gave no way to open them.
 * There is no gutter there, so a tap on the mark is the way in, routed as a
 * gutter click is.
 *
 * The link and selection cases pass against a build without the feature too:
 * they guard against it taking clicks that belong to something else.
 */
describe("opening a thread from reading mode", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const popover = (): Promise<Shown> =>
		page.evaluate(() => {
			const el = document.querySelector(".inline-comment-popover") as HTMLElement | null;
			if (!el) return null;
			return {
				bodies: Array.from(el.querySelectorAll(".inline-comment-body")).map((b) => (b.textContent ?? "").trim()),
				placement: el.dataset.placement ?? null,
			};
		});

	const closePopover = async (): Promise<void> => {
		await page.evaluate(() => window.app.plugins.plugins["margin-comments"].popover?.close());
		await page.waitForTimeout(300);
	};

	const phraseMark = () =>
		page.locator(".markdown-reading-view .inline-comment-reading-mark", { hasText: "a commented phrase" }).first();

	async function commentOn(needle: string, content: string): Promise<void> {
		await page.evaluate(
			async ([text, body]: [string, string]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const at = cm.state.doc.toString().indexOf(text);
				await plugin.createComment(cm, leaf.view.file.path, at, at + text.length, body);
			},
			[needle, content],
		);
		await page.waitForTimeout(800);
	}

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

		await commentOn("a commented phrase", "On the phrase.");
		await commentOn("answer = 42", "On the code.");
		await commentOn(LINKED, "Around the link.");
		await page.evaluate(async () => {
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			await leaf.setViewState({ type: "markdown", state: { file: leaf.view.file.path, mode: "preview" } });
		});
		await page.waitForSelector(".markdown-reading-view .inline-comment-reading-mark", { timeout: 10000 });
		await page.waitForTimeout(800);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens a mark's thread when the mark is clicked (#171)", async () => {
		await phraseMark().click();
		await page.waitForTimeout(700);
		const shown = await popover();
		expect(shown?.bodies).toEqual(["On the phrase."]);
		expect(shown?.placement).not.toBe("sheet");
		await closePopover();
	});

	it("opens a code block's thread from the marked block", async () => {
		const block = page.locator(".markdown-reading-view .inline-comment-reading-block", { has: page.locator("pre") });
		await block.first().click({ position: { x: 24, y: 16 } });
		await page.waitForTimeout(700);
		expect((await popover())?.bodies).toEqual(["On the code."]);
		await closePopover();
	});

	it("leaves a link inside a marked stretch to the link", async () => {
		const marked = await page.evaluate(() => {
			const link = document.querySelector(".markdown-reading-view a.internal-link");
			return link?.closest(".inline-comment-reading-mark, .inline-comment-reading-block") != null;
		});
		// Guard: the link must sit inside something a tap would otherwise open.
		expect(marked).toBe(true);
		await page.locator(".markdown-reading-view a.internal-link").first().click();
		await page.waitForTimeout(700);
		expect(await popover()).toBeNull();
	});

	it("treats a click that ends a text selection as a selection", async () => {
		const opened = await page.evaluate(async () => {
			const mark = Array.from(document.querySelectorAll(".markdown-reading-view .inline-comment-reading-mark")).find(
				(m) => m.textContent === "a commented phrase",
			) as HTMLElement;
			const range = document.createRange();
			range.selectNodeContents(mark);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			mark.click();
			await new Promise((r) => setTimeout(r, 700));
			selection.removeAllRanges();
			return document.querySelector(".inline-comment-popover") !== null;
		});
		expect(opened).toBe(false);
	});

	it("opens as a bottom sheet on a phone", async () => {
		await page.evaluate(() => {
			window.app.plugins.plugins["margin-comments"].sheet = true;
		});
		await phraseMark().click();
		await page.waitForTimeout(700);
		const shown = await popover();
		await page.evaluate(() => {
			window.app.plugins.plugins["margin-comments"].sheet = false;
		});
		expect(shown).toEqual({ bodies: ["On the phrase."], placement: "sheet" });
		await closePopover();
	});

	it("selects the card in the panel instead when the panel is on screen", async () => {
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", { timeout: 10000 });
		await page.evaluate(async () => {
			const ws = window.app.workspace;
			ws.rightSplit.expand();
			ws.setActiveLeaf(ws.getLeavesOfType("markdown")[0], { focus: false });
			await new Promise((r) => setTimeout(r, 900));
		});
		await phraseMark().click();
		await page.waitForTimeout(900);
		const result = await page.evaluate(() => ({
			popover: document.querySelector(".inline-comment-popover") !== null,
			selected: document.querySelector(".inline-comment-card.is-selected .inline-comment-quote-text")?.textContent ?? null,
		}));
		expect(result).toEqual({ popover: false, selected: "a commented phrase" });
	});
});
