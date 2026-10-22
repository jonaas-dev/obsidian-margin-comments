import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import { hashString } from "../../src/utils";

const NOTE = "note.md";
const BODY = "```js\nconst copied = 42;\n```\n\n> [!note]- Folded\n> hidden until opened";

/**
 * The controls Obsidian's renderer wires up inside a comment body.
 *
 * The body is copied into the card rather than moved (#372), and a copy carries
 * no listeners. Measured against a build that copied without rewire(): the copy
 * button copied nothing and the folded callout would not open, while the rest of
 * the suite stayed green.
 */
describe("controls inside a comment body", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	beforeAll(async () => {
		vault = createTempVault({
			[NOTE]: "alpha beta",
			[`.margin-comments/${hashString(NOTE)}.json`]: JSON.stringify({
				version: 1,
				filePath: NOTE,
				comments: [
					{
						id: "c1",
						filePath: NOTE,
						anchor: {
							selectedText: "alpha",
							textHash: hashString("alpha"),
							isLineComment: false,
							contextBefore: "",
							contextAfter: "",
							lineHint: 1,
							startOffset: 0,
							endOffset: 5,
						},
						content: BODY,
						author: "someone",
						createdAt: 1000,
						updatedAt: 1000,
						resolved: false,
						parentId: null,
					},
				],
			}),
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
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-body .callout", { timeout: 10000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("copies the code from a code block's copy button", async () => {
		const copied = await page.evaluate(async () => {
			let written = "";
			navigator.clipboard.writeText = async (text: string) => {
				written = text;
			};
			document.querySelector<HTMLElement>(".inline-comment-body .copy-code-button")?.click();
			await new Promise((resolve) => setTimeout(resolve, 200));
			return written;
		});
		expect(copied.trim()).toBe("const copied = 42;");
	});

	it("keeps a folded callout folded until its title is clicked", async () => {
		const read = () =>
			page.evaluate(() => {
				const content = document.querySelector(".inline-comment-body .callout-content");
				return content ? getComputedStyle(content).display : "missing";
			});
		expect(await read()).toBe("none");
		await page.locator(".inline-comment-body .callout-title").click();
		await page.waitForFunction(
			() => {
				const content = document.querySelector(".inline-comment-body .callout-content");
				return content !== null && getComputedStyle(content).display !== "none";
			},
			null,
			{ timeout: 5000 },
		);
		expect(await read()).not.toBe("none");
	});
});
