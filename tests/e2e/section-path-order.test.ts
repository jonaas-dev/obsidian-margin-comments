import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

import { createAnchor } from "../../src/anchor";
import { hashString } from "../../src/utils";
import type { Comment } from "../../src/types";

const NUMBERED = "01 Long note.md";
const BRACKETED = "(draft) note.md";
const DEEP = "archive/2026/projects/client-work/meetings/weekly/Target note.md";
const BODY = ["first line", "second line"].join("\n");

function comment(filePath: string): Comment {
	const now = 1_700_000_000_000;
	return {
		id: `c-${hashString(filePath)}`,
		filePath,
		anchor: createAnchor(BODY, 0, 5),
		content: "a comment",
		author: "tester",
		createdAt: now,
		updatedAt: now,
		resolved: false,
		parentId: null,
	};
}

function sidecar(filePath: string): [string, string] {
	return [`.margin-comments/${hashString(filePath)}.json`, JSON.stringify({ filePath, comments: [comment(filePath)] })];
}

interface Glyphs {
	/** Left edge of each requested character, in the order asked. */
	left: number[];
	box: { left: number; right: number };
	overflows: boolean;
}

/**
 * #130: the all-notes view drew "01 Long note.md" as "Long note.md 01".
 *
 * The path box is right-to-left so that a long path is cut at its start, and
 * that direction also reordered leading digits and brackets. The DOM text is
 * right either way, so this measures where the glyphs are drawn.
 */
describe("note paths in the all-notes view", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Where characters of one section's path are drawn. Works on either DOM shape. */
	const glyphs = (path: string, indexes: number[]): Promise<Glyphs> =>
		page.evaluate(
			([wanted, at]: [string, number[]]) => {
				const box = Array.from(document.querySelectorAll(".inline-comment-section-path")).find(
					(el) => el.textContent === wanted,
				) as HTMLElement;
				const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
				const node = walker.nextNode() as Text;
				const left = at.map((i) => {
					const range = document.createRange();
					range.setStart(node, i);
					range.setEnd(node, i + 1);
					return range.getBoundingClientRect().left;
				});
				const rect = box.getBoundingClientRect();
				return { left, box: { left: rect.left, right: rect.right }, overflows: box.scrollWidth > box.clientWidth };
			},
			[path, indexes],
		);

	beforeAll(async () => {
		const index = Object.fromEntries(
			[NUMBERED, BRACKETED, DEEP].map((p) => [p, { hash: hashString(p), threads: 1, open: 1 }]),
		);
		vault = createTempVault({
			[NUMBERED]: BODY,
			[BRACKETED]: BODY,
			[DEEP]: BODY,
			...Object.fromEntries([sidecar(NUMBERED), sidecar(BRACKETED), sidecar(DEEP)]),
			".margin-comments/_index.json": JSON.stringify(index),
		});
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await dismissModals(page);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
		await page.selectOption(".inline-comment-scope", "vault");
		await page.waitForSelector(".inline-comment-section-path", { timeout: 10000 });
		await page.waitForTimeout(600);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("draws a name that starts with a number in its written order (#130)", async () => {
		const g = await glyphs(NUMBERED, [0, 3]);
		// Guard: truncation would hide one of the two glyphs and prove nothing.
		expect(g.overflows).toBe(false);
		// "0" before "L".
		expect(g.left[0]).toBeLessThan(g.left[1]);
	});

	it("draws a name that starts with a bracket in its written order", async () => {
		const g = await glyphs(BRACKETED, [0, 8]);
		expect(g.overflows).toBe(false);
		// "(" before the "n" of "note".
		expect(g.left[0]).toBeLessThan(g.left[1]);
	});

	it("still cuts a long path at its start, keeping the file name in view", async () => {
		await page.evaluate(() => {
			(document.querySelector(".inline-comment-panel") as HTMLElement).style.width = "240px";
		});
		await page.waitForTimeout(400);
		const last = DEEP.length - 1;
		const g = await glyphs(DEEP, [0, last]);
		await page.evaluate(() => {
			(document.querySelector(".inline-comment-panel") as HTMLElement).style.width = "";
		});

		// Guard: a path that fits is not cut anywhere.
		expect(g.overflows).toBe(true);
		// The last character is inside the box; the first has been pushed out of it.
		expect(g.left[1]).toBeGreaterThanOrEqual(g.box.left);
		expect(g.left[1]).toBeLessThan(g.box.right);
		expect(g.left[0]).toBeLessThan(g.box.left);
	});
});
