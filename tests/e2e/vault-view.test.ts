import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
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

const ALPHA = "alpha.md";
const BETA = "beta.md";
/** Indexed, but no longer in the vault: what a rename leaves behind today. */
const RENAMED = "renamed.md";

const ALPHA_BODY = ["alpha one", "alpha two"].join("\n");
const BETA_BODY = ["beta one", "beta two"].join("\n");

function comment(id: string, filePath: string, doc: string, text: string, resolved = false): Comment {
	const from = doc.indexOf(text);
	const now = 1_700_000_000_000;
	return {
		id,
		filePath,
		anchor: createAnchor(doc, from, from + text.length),
		content: `comment ${id}`,
		author: "tester",
		createdAt: now,
		updatedAt: now,
		resolved,
		parentId: null,
	};
}

function sidecar(filePath: string, comments: Comment[]): [string, string] {
	return [
		`.margin-comments/${hashString(filePath)}.json`,
		JSON.stringify({ filePath, comments }, null, 2),
	];
}

describe("all-notes view", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/**
	 * Count sidecars actually opened from here on.
	 *
	 * At the adapter, not at `getCommentsForFile`. That method is cached, so
	 * counting calls to it counts callers rather than reads — and any unrelated
	 * one inflates the number without a file being touched, which is how this
	 * came apart: the counter read 4 where the test wanted 1, in a full run,
	 * passing on its own and on a re-run (#94). The index is skipped because it
	 * is read to list the notes, which is the thing being shown to cost nothing.
	 *
	 * The cache is not touched here. Emptying it mid-run made things worse, not
	 * better: a render still in flight re-read two sidecars the moment it was
	 * cleared, and the count depended on how far that render had got. Where a
	 * test needs a note to be cold, it evicts that one note, settled, below.
	 */
	async function watchReads(): Promise<void> {
		await page.evaluate(async () => {
			const storage = window.app.plugins.plugins["margin-comments"].storage;
			if (window.__reads === undefined) {
				const adapter = storage.adapter;
				const original = adapter.read.bind(adapter);
				adapter.read = (path: string) => {
					// Our sidecars only. The adapter belongs to the whole app, and
					// Obsidian reads its own .obsidian/app.json and appearance.json
					// through it at moments of its own choosing — which is what made
					// this count 2 instead of 0 about one run in three.
					if (path.startsWith(".margin-comments/") && !path.endsWith("_index.json")) {
						window.__reads++;
					}
					return original(path);
				};
				window.__reads = 0;
			}

			// Wait for the plugin to go quiet before zeroing. Work started before
			// this call — a debounced refresh, a render still resolving — lands
			// afterwards and is counted against whatever the test does next. That
			// is the flake in #94: two sidecars, sometimes, arriving late.
			for (let quiet = 0; quiet < 3; ) {
				const before = window.__reads;
				await new Promise((r) => setTimeout(r, 150));
				quiet = window.__reads === before ? quiet + 1 : 0;
			}
			window.__reads = 0;
		});
	}

	const reads = (): Promise<number> => page.evaluate(() => window.__reads);

	async function setScope(scope: string): Promise<void> {
		await page.selectOption(".inline-comment-scope", scope);
		await page.waitForTimeout(700);
	}

	const sectionPaths = (): Promise<string[]> =>
		page.locator(".inline-comment-section-path").allInnerTexts();

	const sectionCounts = (): Promise<string[]> =>
		page.locator(".inline-comment-section-head .inline-comment-filter-count").allInnerTexts();

	beforeAll(async () => {
		const alphaComments = [
			comment("a1", ALPHA, ALPHA_BODY, "alpha one"),
			comment("a2", ALPHA, ALPHA_BODY, "alpha two", true),
		];
		const betaComments = [comment("b1", BETA, BETA_BODY, "beta two")];
		const renamedComments = [comment("r1", RENAMED, "gone text", "gone")];

		vault = createTempVault({
			[ALPHA]: ALPHA_BODY,
			[BETA]: BETA_BODY,
			...Object.fromEntries([
				sidecar(ALPHA, alphaComments),
				sidecar(BETA, betaComments),
				sidecar(RENAMED, renamedComments),
			]),
			".margin-comments/_index.json": JSON.stringify({
				[ALPHA]: { hash: hashString(ALPHA), threads: 2, open: 1 },
				[BETA]: { hash: hashString(BETA), threads: 1, open: 1 },
				[RENAMED]: { hash: hashString(RENAMED), threads: 1, open: 1 },
			}),
		});

		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, ALPHA);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	/**
	 * Load the index and let it be memoised before any read count is taken.
	 *
	 * `loadIndex` rebuilds from every sidecar when the index file cannot be read
	 * or parsed. That is correct — the index is a derived cache, never the source
	 * of truth — but it is two sidecar reads in this vault, and it is what made
	 * the count below come out as 2 roughly one run in five (#94). What is being
	 * tested is what listing costs *with* an index, not what a rebuild costs.
	 */
	async function primeIndex(): Promise<void> {
		await page.evaluate(async () => {
			await window.app.plugins.plugins["margin-comments"].storage.getCommentSummaries();
		});
	}

	it("lists every commented note without opening a single sidecar", async () => {
		// The whole point of the counts living in the index: switching to the
		// vault view must not pay for one read per commented note.
		await primeIndex();
		await watchReads();
		await setScope("vault");

		expect(await sectionPaths()).toEqual([ALPHA, BETA, RENAMED]);
		expect(await reads()).toBe(0);
		expect(await page.locator(".inline-comment-card").count()).toBe(0);
	});

	it("stores the scope in data.json, so it survives a restart", async () => {
		// Read before any filter or sort is touched: those save the whole settings
		// object, so later in the session this file would carry the scope even if
		// changing it saved nothing.
		const data = JSON.parse(
			readFileSync(`${vault.path}/.obsidian/plugins/margin-comments/data.json`, "utf8"),
		);
		expect(data.panelScope).toBe("vault");
	});

	it("takes the counts from the index, per note and in total", async () => {
		expect(await sectionCounts()).toEqual(["2", "1", "1"]);
		expect(await page.locator(".inline-comment-filter-count").allInnerTexts()).toEqual([
			"4",
			"3",
			"1",
			"2",
			"1",
			"1",
		]);
	});

	it("marks a note the vault no longer has, and sorts it last", async () => {
		const missing = page.locator(".inline-comment-section.is-missing");
		expect(await missing.count()).toBe(1);
		expect(await missing.locator(".inline-comment-section-path").innerText()).toBe(RENAMED);
		const paths = await sectionPaths();
		expect(paths[paths.length - 1]).toBe(RENAMED);
	});

	/** Forget one note, so a test that is about opening it starts cold. */
	async function forget(filePath: string): Promise<void> {
		await page.evaluate((path: string) => {
			window.app.plugins.plugins["margin-comments"].storage.cache.delete(path);
		}, filePath);
	}

	it("cannot be moved by a caller that hits the cache", async () => {
		// The counter's own guard, and the whole point of counting at the
		// adapter. Asking for a note's comments three times opens the sidecar
		// once; if this ever reads 3, the counter is measuring callers again and
		// every assertion below is about the wrong thing.
		await primeIndex();
		await forget(ALPHA);
		await watchReads();
		const opened = await page.evaluate(async (path: string) => {
			const storage = window.app.plugins.plugins["margin-comments"].storage;
			await storage.getCommentsForFile(path);
			const afterFirst = window.__reads;
			await storage.getCommentsForFile(path);
			await storage.getCommentsForFile(path);
			return { afterFirst, afterThree: window.__reads };
		}, ALPHA);
		expect(opened).toEqual({ afterFirst: 1, afterThree: 1 });
	});

	it("reads a note only when its section is opened", async () => {
		// Cold on purpose: the cache lives as long as the session, so whether
		// expanding opens a sidecar otherwise depends on which earlier test
		// happened to load this note first.
		await primeIndex();
		await forget(ALPHA);
		await watchReads();
		await page.locator(".inline-comment-section-head").first().click();
		await page.waitForTimeout(700);

		expect(await reads()).toBe(1);
		expect(await page.locator(".inline-comment-card").count()).toBe(2);
	});

	it("collapses again without leaving its cards behind", async () => {
		await page.locator(".inline-comment-section-head").first().click();
		await page.waitForTimeout(500);
		expect(await page.locator(".inline-comment-card").count()).toBe(0);
	});

	it("drops a whole note from the list when the filter excludes it", async () => {
		await page.locator(".inline-comment-filter", { hasText: "Resolved" }).click();
		await page.waitForTimeout(600);

		// Only alpha has anything resolved, and its badge promises exactly one.
		expect(await sectionPaths()).toEqual([ALPHA]);
		expect(await sectionCounts()).toEqual(["1"]);

		await page.locator(".inline-comment-section-head").first().click();
		await page.waitForTimeout(700);
		expect(await page.locator(".inline-comment-card").count()).toBe(1);
	});

	it("opens the note and jumps to the comment when a card is clicked", async () => {
		await page.locator(".inline-comment-filter", { hasText: "Open" }).click();
		await page.waitForTimeout(600);

		const beta = page.locator(".inline-comment-section", { hasText: BETA });
		await beta.locator(".inline-comment-section-head").click();
		await page.waitForTimeout(700);
		await beta.locator(".inline-comment-card").first().click();
		await page.waitForTimeout(1200);

		const where = await page.evaluate(() => {
			const leaf = window.app.workspace
				.getLeavesOfType("markdown")
				.find((l: { view: { editor?: unknown } }) => l.view.editor);
			return { path: leaf.view.file.path, line: leaf.view.editor.getCursor().line };
		});
		expect(where).toEqual({ path: BETA, line: 1 });
	});

	it("updates the counts, and keeps other sections open, after resolving here", async () => {
		const beta = page.locator(".inline-comment-section", { hasText: BETA });
		await beta.locator(".inline-comment-card").first().hover();
		await beta.locator('[aria-label="Resolve"]').first().click();
		await page.waitForTimeout(1500);

		// beta leaves the Open filter entirely, and the totals follow: three open
		// threads become two, and one resolved becomes two.
		expect(await sectionPaths()).toEqual([ALPHA, RENAMED]);
		expect(await page.locator(".inline-comment-filter-count").allInnerTexts()).toEqual([
			"4",
			"2",
			"2",
			"1",
			"1",
		]);
		// alpha was open before the refresh and still is, with its card drawn.
		const alpha = page.locator(".inline-comment-section", { hasText: ALPHA });
		expect(await alpha.locator(".inline-comment-card").count()).toBe(1);
	});

	it("redraws an open section from fresh data, not from what it read on expand", async () => {
		await page.locator(".inline-comment-filter", { hasText: "All" }).click();
		await page.waitForTimeout(600);

		const alpha = page.locator(".inline-comment-section", { hasText: ALPHA });
		expect(await alpha.locator(".inline-comment-card.is-resolved").count()).toBe(1);

		await alpha.locator(".inline-comment-card").first().hover();
		await alpha.locator('[aria-label="Resolve"]').first().click();
		await page.waitForTimeout(1500);

		// Both of alpha's threads are resolved now. A section redrawn from the
		// copy it loaded on expand would still show one of them open.
		expect(await alpha.locator(".inline-comment-card.is-resolved").count()).toBe(2);
	});

	it("goes back to the open note on demand", async () => {
		await setScope("note");
		expect(await page.locator(".inline-comment-section").count()).toBe(0);
		expect(await page.locator(".inline-comment-panel-title").innerText()).toBe("beta");
	});
});
