import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["first line", "the commented line", "third line"].join("\n");

describe("settings tab", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/**
	 * Render the tab into a container of our own, full-screen and on top.
	 *
	 * Obsidian's settings modal never attaches in this harness: `app.setting.open()`
	 * runs, the tab's containerEl exists and reports `isConnected`, and no `.modal`
	 * ever reaches the DOM. Same shape as `Menu`. So the tab is rendered directly,
	 * which is what it is responsible for; the chrome around it is not.
	 *
	 * Full-screen and fixed for a reason: a container with no size lays the
	 * settings out correctly and Playwright still refuses to click them, which
	 * surfaces as a 30-second timeout rather than as an invisible element.
	 */
	async function openTab(): Promise<void> {
		await page.evaluate(() => {
			const host = document.getElementById("ic-settings-host") ?? document.body.createDiv();
			host.id = "ic-settings-host";
			host.setAttribute(
				"style",
				"position:fixed;inset:0;z-index:99999;overflow:auto;padding:1em;" +
					"background:var(--background-primary);",
			);
			const tab = window.app.setting.pluginTabs.find(
				(t: { id: string }) => t.id === "inline-comments",
			) as unknown as { containerEl: HTMLElement; display(): void };
			tab.containerEl = host;
			tab.display();
		});
		await page.waitForTimeout(400);
	}

	async function closeTab(): Promise<void> {
		await page.evaluate(() => document.getElementById("ic-settings-host")?.remove());
		await page.waitForTimeout(400);
	}

	/** Scoped to our container: Obsidian's own settings pages use these classes too. */
	const settingNamed = (name: string) =>
		page.locator("#ic-settings-host .setting-item", {
			has: page.locator(".setting-item-name", { hasText: name }),
		});

	/**
	 * The live control of a setting.
	 *
	 * Obsidian builds every dropdown twice — the real one and a hidden
	 * `is-measuring` clone it sizes the first from — so an unqualified match
	 * fails strict mode rather than quietly picking the wrong one.
	 */
	const controlOf = (name: string, selector: string) =>
		settingNamed(name).locator(selector).first();

	const storedSettings = (): Record<string, unknown> =>
		JSON.parse(
			readFileSync(`${vault.path}/.obsidian/plugins/inline-comments/data.json`, "utf8"),
		);

	const liveSettings = (): Promise<Record<string, unknown>> =>
		page.evaluate(() => window.app.plugins.plugins["inline-comments"].settings);

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "inline-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);
		await openTab();
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("registers a settings tab at all", async () => {
		const registered = await page.evaluate(() =>
			window.app.setting.pluginTabs.some((t: { id: string }) => t.id === "inline-comments"),
		);
		expect(registered).toBe(true);
	});

	it("offers the comment count now that something reads it", async () => {
		// It was deliberately left out while nothing read it (#67): a switch with
		// nothing behind it is worse than no switch. #68 gave it a feature, and
		// the E2E suite in gutter-count.test.ts is what proves the switch works.
		expect(await settingNamed("Comment count").count()).toBe(1);
	});

	it("writes the comment count straight to disk too", async () => {
		await controlOf("Comment count", ".checkbox-container").click();
		await page.waitForTimeout(800);
		expect(storedSettings().showCommentCount).toBe(false);
		await controlOf("Comment count", ".checkbox-container").click();
		await page.waitForTimeout(800);
		expect(storedSettings().showCommentCount).toBe(true);
	});

	it("describes what a setting costs, not what its label already says", async () => {
		const desc = await settingNamed("Gutter icons")
			.locator(".setting-item-description")
			.innerText();
		expect(desc.toLowerCase()).not.toContain("show icons in the gutter");
		expect(desc).toContain("command");
	});

	it("writes a change straight to disk, with no save button", async () => {
		await controlOf("Gutter icons", ".checkbox-container").click();
		await page.waitForTimeout(800);
		expect(storedSettings().showGutterIcons).toBe(false);
	});

	it("switches it back on again, so the control is not one-way", async () => {
		// Deliberately not asserting on the markers here. That assertion passed
		// against a build whose commit() never called refresh: clicking the tab
		// stirs the workspace, active-leaf-change fires, and the markers are
		// redrawn by something other than the setting. The sort-order test below
		// is what proves a change reaches an open view.
		await controlOf("Gutter icons", ".checkbox-container").click();
		await page.waitForTimeout(800);
		expect(storedSettings().showGutterIcons).toBe(true);
		expect((await liveSettings()).showGutterIcons).toBe(true);
	});

	it("trims an author name so spaces are not stamped on comments", async () => {
		await controlOf("Author name", "input[type=text]").fill("  Ada  ");
		await page.waitForTimeout(800);
		expect((await liveSettings()).author).toBe("Ada");
		expect(storedSettings().author).toBe("Ada");
	});

	it("reveals the colour picker only once the theme stops driving the colour", async () => {
		expect(await settingNamed("Highlight colour").count()).toBe(0);
		await controlOf("Follow the theme accent", ".checkbox-container").click();
		await page.waitForTimeout(800);
		expect(await settingNamed("Highlight colour").count()).toBe(1);
	});

	it("publishes the chosen colour to the stylesheet as it is chosen", async () => {
		const variable = await page.evaluate(() =>
			getComputedStyle(document.body).getPropertyValue("--ic-highlight").trim(),
		);
		expect(variable).not.toBe("");
		expect(storedSettings().highlightColor).not.toBe("theme");
	});

	it("hides the picker again when the theme takes over", async () => {
		await controlOf("Follow the theme accent", ".checkbox-container").click();
		await page.waitForTimeout(800);
		expect(await settingNamed("Highlight colour").count()).toBe(0);
		expect(storedSettings().highlightColor).toBe("theme");
	});

	it("changes the sort order the panel is already using", async () => {
		await closeTab();
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("inline-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		await openTab();

		await controlOf("Sort order", "select").selectOption("date");
		await page.waitForTimeout(800);
		expect(storedSettings().sortOrder).toBe("date");
		// The acceptance criterion, and the only assertion here that only a
		// refresh can satisfy: the panel's own dropdown is the same setting, and
		// it is redrawn from scratch on every repaint.
		expect(await page.locator(".inline-comment-sort").inputValue()).toBe("date");
	});

	it("moves an open panel to the other side", async () => {
		const sideOf = (): Promise<string> =>
			page.evaluate(() => {
				const leaf = window.app.workspace.getLeavesOfType("inline-comments-panel")[0];
				return window.app.workspace.leftSplit.containerEl.contains(leaf.containerEl)
					? "left"
					: "right";
			});
		expect(await sideOf()).toBe("right");

		await controlOf("Side", "select").selectOption("left");
		await page.waitForTimeout(1500);
		expect(storedSettings().panelPosition).toBe("left");
		expect(await sideOf()).toBe("left");
	});
});
