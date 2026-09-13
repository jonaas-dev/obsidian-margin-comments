import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["alpha beta gamma", "delta epsilon"].join("\n");

/**
 * #105: the empty state names the way to fill it.
 *
 * In the empty state and nowhere else — a permanent hint bar would tax every
 * reader forever to teach one thing once — and with the binding actually in
 * effect, not a hardcoded default.
 */
describe("the panel's empty state", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const hint = (): Promise<string | null> =>
		page.evaluate(
			() => document.querySelector(".inline-comment-empty-hint")?.textContent ?? null,
		);

	/**
	 * Bind the command the way the settings tab does.
	 *
	 * `setHotkeys` and `removeHotkeys` are the real API; `customKeys` sits on the
	 * prototype and writing to it did nothing at all.
	 */
	async function setBinding(binding: { modifiers: string[]; key: string } | null): Promise<void> {
		await page.evaluate(
			async (b: { modifiers: string[]; key: string } | null) => {
				const manager = (window.app as unknown as {
					hotkeyManager: {
						setHotkeys(id: string, keys: unknown[]): void;
						removeHotkeys(id: string): void;
					};
				}).hotkeyManager;
				const id = "margin-comments:add-comment";
				// An empty list is a cleared binding: removeHotkeys would restore
				// the default instead, which is a different case.
				manager.setHotkeys(id, b === null ? [] : [b]);
				const plugin = window.app.plugins.plugins["margin-comments"];
				await plugin.refresh();
			},
			binding,
		);
		await page.waitForTimeout(800);
	}

	/** Put the command back on its default binding. */
	async function resetBinding(): Promise<void> {
		await page.evaluate(async () => {
			const manager = (window.app as unknown as {
				hotkeyManager: { removeHotkeys(id: string): void };
			}).hotkeyManager;
			manager.removeHotkeys("margin-comments:add-comment");
			await window.app.plugins.plugins["margin-comments"].refresh();
		});
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
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("names the command on a fresh install, which binds no key (#122)", async () => {
		expect(await hint()).toBe("Select some text and run “Add comment to selection”.");
	});

	it("names the reader's own binding when they have set one", async () => {
		// Asserted by setting one, not by trusting the default path — a
		// hardcoded default would pass the test above and fail here.
		await setBinding({ modifiers: ["Alt"], key: "k" });
		expect(await hint()).toBe("Select some text and press ⌥K.");
	});

	it("names the command when the binding has been cleared", async () => {
		await setBinding(null);
		expect(await hint()).toBe("Select some text and run “Add comment to selection”.");
	});

	it("goes back to naming the command when the reader's binding is removed", async () => {
		// removeHotkeys restores the default, and the default is now no binding at
		// all — so a leftover default would show up here as a key combination.
		await setBinding({ modifiers: ["Alt"], key: "k" });
		await resetBinding();
		expect(await hint()).toBe("Select some text and run “Add comment to selection”.");
	});

	it("describes a tap rather than a hover on a touch device (#126)", async () => {
		const message = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.touch = true;
			await plugin.refresh();
			await new Promise((r) => setTimeout(r, 600));
			const text = document.querySelector(".inline-comment-empty")?.firstElementChild?.textContent ?? null;
			plugin.touch = false;
			await plugin.refresh();
			return text;
		});
		await page.waitForTimeout(600);
		expect(message).toBe("Tap a line, then the comment icon beside it, to add the first comment.");
	});

	it("says nothing once the note has a comment", async () => {
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: { state: { doc: { toString(): string } } } }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.createComment(cm, leaf.view.file.path, at, at + 4, "A comment.");
		});
		await page.waitForTimeout(1400);

		expect(await hint()).toBeNull();
	});

	it("says nothing under a filter that merely hides the comments", async () => {
		// "No resolved comments yet" is not a note waiting to be started, and
		// answering a question nobody asked there is exactly the clutter the
		// issue weighed against.
		await page.locator(".inline-comment-filter", { hasText: "Resolved" }).click();
		await page.waitForTimeout(700);

		const empty = await page.evaluate(
			() => document.querySelector(".inline-comment-empty")?.textContent ?? null,
		);
		expect(empty).not.toBeNull();
		expect(await hint()).toBeNull();
	});

	it("says nothing in the all-notes view, where the command does not apply", async () => {
		await page.locator(".inline-comment-filter", { hasText: "All" }).click();
		await page.waitForTimeout(500);
		await page.selectOption(".inline-comment-scope", "vault");
		await page.waitForTimeout(900);

		expect(await hint()).toBeNull();
	});
});
