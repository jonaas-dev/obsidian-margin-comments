import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import type { Comment } from "../../src/types";

interface EditorViewLike {
	state: { doc: { toString(): string } };
	dispatch(spec: unknown): void;
}

const NOTE = "note.md";
const BODY = [
	"alpha beta gamma on the first line",
	"delta epsilon zeta on the second line",
	"eta theta iota on the third line",
].join("\n");

/**
 * #75 and #81: what a selection means when the comment is asked for.
 *
 * Driven through `openComposer`, which is the single entry both the gutter
 * click and the add-comment command go through — the bugs were in the decision
 * it makes, not in either caller.
 */
describe("asking for a comment", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	function storedAnchors(): string[] {
		const dir = `${vault.path}/.margin-comments`;
		const file = readdirSync(dir).find((f) => f !== "_index.json");
		if (!file) return [];
		const sidecar = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as {
			comments: Comment[];
		};
		return sidecar.comments.map((c) =>
			c.anchor.isLineComment ? `LINE:${c.anchor.selectedText}` : c.anchor.selectedText,
		);
	}

	/** Select `text`, then ask for a comment on `line`. */
	async function askOn(text: string | null, line: number): Promise<void> {
		await page.evaluate(
			async ([needle, at]: [string | null, number]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
				const doc = cm.state.doc.toString();
				if (needle === null) {
					cm.dispatch({ selection: { anchor: 0, head: 0 } });
				} else {
					const start = doc.indexOf(needle);
					cm.dispatch({ selection: { anchor: start, head: start + needle.length } });
				}
				plugin.routing.open(cm, at);
			},
			[text, line],
		);
		await page.waitForTimeout(700);
	}

	/** Submit whatever the composer is holding. */
	async function submit(body: string): Promise<void> {
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(body);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1200);
	}

	const composerOpen = (): Promise<boolean> =>
		page.evaluate(() => document.querySelector(".inline-comment-composer") !== null);
	const popoverOpen = (): Promise<boolean> =>
		page.evaluate(() => document.querySelector(".inline-comment-popover") !== null);

	async function dismiss(): Promise<void> {
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.routing.close();
			plugin.popover?.close?.();
		});
		await page.waitForTimeout(400);
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

		await askOn("beta", 1);
		await submit("a comment on beta");
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("anchors the first comment to the words that were selected", async () => {
		expect(storedAnchors()).toEqual(["beta"]);
	});

	it("gives a commented line a second thread when other words are selected (#75)", async () => {
		await askOn("gamma", 1);
		expect(await composerOpen()).toBe(true);
		expect(await popoverOpen()).toBe(false);
		await submit("a comment on gamma");

		expect(storedAnchors().sort()).toEqual(["beta", "gamma"]);
	});

	it("opens the thread whose own words were selected, rather than a twin", async () => {
		await askOn("beta", 1);
		expect(await composerOpen()).toBe(false);
		expect(await popoverOpen()).toBe(true);
		await dismiss();
	});

	it("still opens the thread on a bare click, which is the reading case", async () => {
		await askOn(null, 1);
		expect(await composerOpen()).toBe(false);
		expect(await popoverOpen()).toBe(true);
		await dismiss();
	});

	it("ignores a selection on another line and comments the line clicked (#81)", async () => {
		// The bug: this stored the comment against "epsilon", on line 2, while
		// the reader had clicked line 3 and the composer had opened beside it.
		await askOn("epsilon", 3);
		expect(await composerOpen()).toBe(true);
		await submit("a comment on the third line");

		const anchors = storedAnchors();
		expect(anchors).toContain("LINE:eta theta iota on the third line");
		expect(anchors).not.toContain("epsilon");
	});

	it("lets a resolved thread's own words be commented again (#113)", async () => {
		// A resolved thread is settled, and the editor shows no sign of it: no
		// marker, no highlight. It used to answer anyway, so selecting inside its
		// words opened nothing and quietly selected the resolved card instead —
		// measured, { composer: false, popover: false, selectedInPanel: 1 }.
		// A word nothing has touched yet, so the only thread on it is the one
		// this test resolves.
		await askOn("epsilon", 2);
		expect(await composerOpen()).toBe(true);
		await submit("a comment that will be resolved");

		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile("note.md");
			const onEpsilon = comments.filter(
				(c: { anchor: { selectedText: string } }) => c.anchor.selectedText === "epsilon",
			);
			for (const c of onEpsilon) await plugin.setResolved(c, true);
		});
		await page.waitForTimeout(1400);

		// Selecting inside its words has to compose, not surface the settled one.
		await askOn("epsilon", 2);
		expect(await composerOpen()).toBe(true);
		expect(await popoverOpen()).toBe(false);
		await submit("a second comment, after the first was resolved");

		expect(storedAnchors().filter((a) => a === "epsilon")).toHaveLength(2);
	});

	it("composes on a line whose only threads are resolved (#113)", async () => {
		// No selection at all. The line looks uncommented — nothing is marked —
		// so the affordance has to lead somewhere.
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile("note.md");
			for (const c of comments) {
				if (c.parentId === null) await plugin.setResolved(c, true);
			}
		});
		await page.waitForTimeout(1400);

		await askOn(null, 2);
		expect(await composerOpen()).toBe(true);
		await dismiss();
	});

	it("shows the marker's own thread again once it is reopened (#113)", async () => {
		// The other half: reopening restores the behaviour #75 established, so
		// the exclusion is about resolved state and not about forgetting threads.
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const comments = await plugin.storage.getCommentsForFile("note.md");
			const beta = comments.find(
				(c: { anchor: { selectedText: string } }) => c.anchor.selectedText === "beta",
			);
			await plugin.setResolved(beta, false);
		});
		await page.waitForTimeout(1400);

		await askOn("beta", 1);
		expect(await composerOpen()).toBe(false);
		expect(await popoverOpen()).toBe(true);
		await dismiss();
	});
});
