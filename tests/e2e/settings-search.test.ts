import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * #250: a settings tab that only implements display() does not take part in
 * Obsidian's settings search on 1.13 or later. Measured before the change:
 * searching Settings for "author" returned "No settings found." while a control
 * term returned Obsidian's own rows, so search worked and we were missing from it.
 */
describe("the settings tab in Obsidian's settings search", () => {
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;

	const search = (term: string): Promise<string> =>
		page.evaluate(async (query: string) => {
			const setting: any = (window.app as any).setting;
			setting.open();
			await new Promise((r) => setTimeout(r, 400));
			setting.searchComponent.setValue(query);
			setting.searchComponent.inputEl.dispatchEvent(new Event("input"));
			await new Promise((r) => setTimeout(r, 600));
			return (setting.searchResultsEl as HTMLElement)?.innerText ?? "";
		}, term);

	beforeAll(async () => {
		vault = createTempVault({ "note.md": "alpha" });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await dismissModals(page);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("finds a setting by a word only this plugin uses", async () => {
		// "author" appears in no built-in setting, so a hit can only be ours.
		const results = await search("author");
		expect(results).toMatch(/author name/i);
	});

	it("finds one by a word the built-in settings also use", async () => {
		// "highlight" matches Obsidian's own rows too; ours has to be among them
		// rather than crowded out.
		const results = await search("highlight");
		expect(results).toMatch(/highlight commented lines/i);
	});

	it("still searches Obsidian's own settings", async () => {
		// A control, so a pass above cannot come from the search being broken in
		// a way that returns everything.
		expect(await search("theme")).toMatch(/theme/i);
	});
});
