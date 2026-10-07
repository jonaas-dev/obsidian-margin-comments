import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOTE = "note.md";
const BODY = ["alpha beta gamma", "delta epsilon"].join("\n");

/**
 * #265: `window-open` only fires for windows opened after it is subscribed to, so
 * a popout that already existed when the plugin loaded never got a document
 * listener. Its marks were painted and did nothing. That is every reload of the
 * plugin with a popout open — updating it, or disabling and enabling it.
 *
 * The existing popout test opens the popout after the plugin, which is the one
 * order that already worked.
 */
describe("a popout that was open before the plugin loaded", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let main: any;
	let popout: any;

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		main = session.page;
		await waitForWorkspace(main);
		await enablePlugin(main, "margin-comments");
		await dismissModals(main);

		await main.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await main.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await main.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: unknown }).cm;
			await plugin.routing.createComment(cm, note, 0, 5, "a thread to open from the popout");
		}, NOTE);
		await main.waitForTimeout(1000);

		const before = main.context().pages().length;
		await main.evaluate((note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			const leaf = window.app.workspace.openPopoutLeaf();
			void leaf.openFile(file, { state: { mode: "preview" } });
		}, NOTE);
		for (let i = 0; i < 40 && main.context().pages().length === before; i++) {
			await main.waitForTimeout(250);
		}
		popout = main
			.context()
			.pages()
			.find((p: any) => p !== main && !p.url().startsWith("devtools://"));
		await popout.waitForSelector(".markdown-reading-view", { timeout: 15000 });

		// The reload the issue is about: the popout outlives it, so it is already
		// open the next time onload runs.
		await main.evaluate(async () => {
			await window.app.plugins.disablePlugin("margin-comments");
		});
		await main.waitForTimeout(1000);
		await enablePlugin(main, "margin-comments");
		await main.waitForTimeout(2000);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens a thread from a mark in the popout", async () => {
		await popout.waitForSelector(".markdown-reading-view .inline-comment-reading-mark", {
			timeout: 15000,
		});
		await popout.locator(".markdown-reading-view .inline-comment-reading-mark").first().click();

		// Waited for, not slept through: this is the heaviest test in the suite —
		// a popout, a plugin reload, then a click in the second window — so a fixed
		// delay is the first thing to come up short under load (#294). In the
		// popout, which is the window the reader clicked in (#236).
		await popout.waitForSelector(".inline-comment-popover", { timeout: 15000 });
		expect(await popout.locator(".inline-comment-popover").count()).toBe(1);
	});

	it("clears the panel's selection when the reader clicks in the popout", async () => {
		await main.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await main.waitForSelector(".inline-comment-panel .inline-comment-card", {
			timeout: 10000,
		});

		const selected = await main.evaluate(async (note: string) => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const roots = (await plugin.storage.getCommentsForFile(note)).filter(
				(c: { parentId: string | null }) => c.parentId === null,
			);
			const leaf = window.app.workspace.getLeavesOfType("margin-comments-panel")[0];
			await leaf.view.select(roots[0].id);
			return document.querySelectorAll(".inline-comment-card.is-selected").length;
		}, NOTE);

		await popout
			.locator(".markdown-reading-view")
			.first()
			.click({ position: { x: 5, y: 5 } });
		// Polled until the selection clears rather than read once after a delay.
		await main.waitForFunction(
			() => document.querySelectorAll(".inline-comment-card.is-selected").length === 0,
			undefined,
			{ timeout: 15000 },
		);
		const after = await main.evaluate(
			() => document.querySelectorAll(".inline-comment-card.is-selected").length,
		);

		expect({ selected, after }).toEqual({ selected: 1, after: 0 });
	});
});
