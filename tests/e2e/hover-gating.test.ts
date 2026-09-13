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
const BODY = ["alpha beta gamma", "delta epsilon zeta"].join("\n");

/**
 * #156: a touch browser keeps :hover on the last element tapped, so every hover
 * style stayed painted on whatever had been touched last.
 *
 * Read from the CSSOM rather than by hovering: Obsidian desktop is a pointer that
 * hovers, where a gated rule and an ungated one look the same. The last case does
 * hover, so the gating cannot have switched the styling off where it belongs.
 */
describe("hover styling", () => {
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
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.routing.createComment(cm, leaf.view.file.path, at, at + 4, "On beta.");
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", { timeout: 10000 });
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("applies only to pointers that can hover (#156)", async () => {
		const result = await page.evaluate(() => {
			const found: { selector: string; gated: boolean }[] = [];
			const walk = (rules: CSSRuleList, gated: boolean): void => {
				for (const rule of Array.from(rules)) {
					if (rule instanceof CSSStyleRule) {
						const selector = rule.selectorText;
						if (selector.includes("inline-comment") && selector.includes(":hover")) {
							found.push({ selector, gated });
						}
					} else if (rule instanceof CSSMediaRule) {
						walk(rule.cssRules, gated || /\(\s*hover\s*:\s*hover\s*\)/.test(rule.conditionText));
					} else if ("cssRules" in rule) {
						walk((rule as CSSGroupingRule).cssRules, gated);
					}
				}
			};
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList;
				try {
					rules = sheet.cssRules;
				} catch {
					continue; // A cross-origin sheet cannot be read, and none of those is ours.
				}
				walk(rules, false);
			}
			return { total: found.length, ungated: found.filter((r) => !r.gated).map((r) => r.selector) };
		});
		// Guard: the plugin's stylesheet was found, with hover rules in it to check.
		expect(result.total).toBeGreaterThanOrEqual(10);
		expect(result.ungated).toEqual([]);
	});

	it("still paints a card's hover background under a mouse", async () => {
		expect(await page.evaluate(() => window.matchMedia("(hover: hover)").matches)).toBe(true);
		const card = page.locator(".inline-comment-panel .inline-comment-card").first();
		await page.mouse.move(0, 0);
		await page.waitForTimeout(250);
		const idle = await card.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor);
		await card.hover();
		await page.waitForTimeout(250);
		const hovered = await card.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor);
		expect(hovered).not.toBe(idle);
	});
});
