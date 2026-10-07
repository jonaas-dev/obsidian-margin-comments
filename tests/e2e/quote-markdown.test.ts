import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const LINE = "A second paragraph with **bold words** in it, and a [[Target|link]] too.";
const BODY = ["First paragraph.", "", LINE].join("\n");
const SHOWN = "A second paragraph with bold words in it, and a link too.";

/**
 * #128: the card quoted raw Markdown syntax.
 *
 * Through the real card path, and with the stored anchor read back, because the
 * fix must change what is shown and nothing that is matched against.
 */
describe("Markdown in the quoted text", () => {
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

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (
				leaf.view.editor as unknown as {
					cm: { state: { doc: { line(n: number): { from: number } } } };
				}
			).cm;
			// from === to: a whole-line comment, which quotes the line as written.
			const from = cm.state.doc.line(3).from;
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				from,
				from,
				"On the formatted line.",
			);
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-quote", {
			timeout: 10000,
		});
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("shows the words without their syntax (#128)", async () => {
		const text = await page.evaluate(
			() =>
				document.querySelector(".inline-comment-panel .inline-comment-quote-text")
					?.textContent,
		);
		expect(text).toBe(SHOWN);
	});

	it("names it the same way for the tooltip and a screen reader", async () => {
		const attrs = await page.evaluate(() => {
			const quote = document.querySelector(
				".inline-comment-panel .inline-comment-quote",
			) as HTMLElement;
			return { title: quote.getAttribute("title"), label: quote.getAttribute("aria-label") };
		});
		expect(attrs.title).toBe(SHOWN);
		expect(attrs.label).toBe(`Go to "${SHOWN}" in the note`);
	});

	it("keeps the stored anchor on the source text, which is what matching uses", async () => {
		const dir = `${vault.path}/.margin-comments`;
		const file = readdirSync(dir).find((f) => f !== "_index.json")!;
		const sidecar = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
		expect(sidecar.comments[0].anchor.selectedText).toBe(LINE);
	});
});
