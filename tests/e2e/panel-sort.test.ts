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
const BODY = ["first line of the note", "second line of the note", "third line"].join("\n");

describe("panel sorting", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Comment a line through the UI, the way a person would. */
	async function commentOnLine(index: number, body: string): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(index).boundingBox();
		const x = gutters.x + gutters.width / 2;
		const y = line.y + line.height / 2;
		await page.mouse.move(x, y);
		await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
		await page.mouse.click(x, y);
		await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
		await page.locator(".inline-comment-composer-input").click();
		await page.locator(".inline-comment-composer-input").fill(body);
		await page.locator(".inline-comment-composer .mod-cta").click();
		await page.waitForTimeout(1200);
	}

	async function chooseSort(order: string): Promise<void> {
		await page.selectOption(".inline-comment-sort", order);
		await page.waitForTimeout(600);
	}

	const quotes = () => page.locator(".inline-comment-quote").allInnerTexts();

	beforeAll(async () => {
		vault = createTempVault({ [NOTE]: BODY });
		session = await launchObsidian(vault.path);
		page = session.page;
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(true).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".cm-editor", { timeout: 30000 });
		await dismissModals(page);

		// Earlier line commented first, so document order and creation order
		// disagree — otherwise both sorts would produce the same list and prove
		// nothing.
		await commentOnLine(0, "comment on the first line");
		await commentOnLine(2, "comment on the third line");

		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 180000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("opens in document order", async () => {
		expect(await page.locator(".inline-comment-card").count()).toBe(2);
		expect((await quotes())[0]).toContain("first line of the note");
	});

	it("puts the newest thread first under 'Date created'", async () => {
		await chooseSort("date");
		expect((await quotes())[0]).toContain("third line");
	});

	it("reorders on the reply, not the root, under 'Last activity'", async () => {
		// The first-line thread is the older of the two; a reply to it has to
		// outrank a newer thread nobody has touched since.
		await page.locator(".inline-comment-card").last().hover();
		const replyInput = page.locator(".inline-comment-replybox-input").last();
		await replyInput.click();
		await replyInput.fill("a reply that revives the older thread");
		await page.locator(".inline-comment-send").last().click();
		await page.waitForTimeout(1500);

		await chooseSort("lastActivity");
		expect((await quotes())[0]).toContain("first line of the note");
	});

	it("stores the sort order in data.json, so it survives a restart", async () => {
		const data = JSON.parse(
			readFileSync(`${vault.path}/.obsidian/plugins/margin-comments/data.json`, "utf8"),
		);
		expect(data.sortOrder).toBe("lastActivity");
	});

	it("gives the sort control its own row instead of letting it wrap into one", async () => {
		// #72: the sort <select> used to be a fourth item in the filter bar's
		// wrapping flex row. There is never width for it there, so it always
		// wrapped and sat alone against the right edge — an overflow that read
		// as a bug. The row is now declared, and the control fills it.
		const layout = await page.evaluate(() => {
			const bar = document.querySelector(".inline-comment-filters") as HTMLElement;
			const sort = document.querySelector(".inline-comment-sort") as HTMLElement;
			const segments = Array.from(
				document.querySelectorAll(".inline-comment-filter"),
			) as HTMLElement[];
			const header = document.querySelector(".inline-comment-panel-header") as HTMLElement;
			return {
				sortIsInsideFilterBar: bar.contains(sort),
				selectsInHeader: header.querySelectorAll("select").length,
				firstSegmentLeft: segments[0].getBoundingClientRect().left,
				sortLeft: sort.getBoundingClientRect().left,
				segmentTops: segments.map((el) => Math.round(el.getBoundingClientRect().top)),
				segmentCount: segments.length,
			};
		});

		expect(layout.segmentCount).toBe(3);
		expect(layout.sortIsInsideFilterBar).toBe(false);
		// Nor did it move up beside the scope dropdown, the other option in #72:
		// the header keeps the one <select> it had.
		expect(layout.selectsInHeader).toBe(1);
		// Flush with the stack of controls, not pushed to the right edge.
		expect(Math.abs(layout.sortLeft - layout.firstSegmentLeft)).toBeLessThan(1.5);
		// The three segments stayed on one row.
		expect(new Set(layout.segmentTops).size).toBe(1);
	});

	it("keeps the filter segments on one row down to a 200px panel", async () => {
		// Measured on a clone in a fixed-width container: the real sidedock
		// refuses to resize from a script, and the widths that matter (the
		// 300px default and below) are exactly where the old bar wrapped.
		const rows = await page.evaluate(async () => {
			const panel = document.querySelector(".inline-comment-panel") as HTMLElement;
			const host = document.createElement("div");
			host.style.cssText = "position:fixed;top:0;left:0;z-index:9999";
			document.body.appendChild(host);

			const out: {
				width: number;
				barRows: number;
				sortOffsetFromSegments: number;
				titleShare: number;
			}[] = [];
			for (const width of [300, 240, 200]) {
				host.style.width = `${width}px`;
				host.innerHTML = "";
				const clone = panel.cloneNode(true) as HTMLElement;
				host.appendChild(clone);
				const title = clone.querySelector(".inline-comment-panel-title") as HTMLElement | null;
				if (title) title.textContent = "Meeting notes 2026-09-08";
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

				const bar = clone.querySelector(".inline-comment-filters") as HTMLElement;
				const sort = clone.querySelector(".inline-comment-sort") as HTMLElement;
				const segments = Array.from(
					clone.querySelectorAll(".inline-comment-filter"),
				) as HTMLElement[];
				// Every child of the bar, not just the segments: the wrap this
				// guards against was the sort control's, and counting segments
				// alone passed against the very layout #72 reports.
				const barChildren = Array.from(bar.children) as HTMLElement[];
				out.push({
					width,
					barRows: new Set(barChildren.map((el) => Math.round(el.getBoundingClientRect().top)))
						.size,
					sortOffsetFromSegments: Math.abs(
						sort.getBoundingClientRect().left - segments[0].getBoundingClientRect().left,
					),
					titleShare: title ? title.getBoundingClientRect().width / width : 1,
				});
			}
			host.remove();
			return out;
		});

		for (const row of rows) {
			// A long note title always clips at these widths; what must not happen
			// is the header giving its width away. The alternative considered in
			// #72 — moving sort up beside the scope dropdown — bought the single
			// row by crushing the title to 24px at 240 and to nothing at 200.
			// Measured here: 167 / 122 / 82.
			expect({ width: row.width, roomy: row.titleShare > 0.3 }).toEqual({
				width: row.width,
				roomy: true,
			});
			expect({ width: row.width, barRows: row.barRows }).toEqual({
				width: row.width,
				barRows: 1,
			});
			// And the sort control lines up under them rather than being pushed
			// to the right edge, which is what made the wrap read as overflow.
			expect({ width: row.width, aligned: row.sortOffsetFromSegments < 1.5 }).toEqual({
				width: row.width,
				aligned: true,
			});
		}
	});

	it("does not go back to disk to change the sort order", async () => {
		// Filter and sort are view decisions over data already loaded. Re-reading
		// the sidecar on every click would be an I/O round trip for bytes the
		// panel is holding.
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const storage = plugin.storage;
			window.__reads = 0;
			const original = storage.getCommentsForFile.bind(storage);
			storage.getCommentsForFile = (path: string) => {
				window.__reads++;
				return original(path);
			};
		});

		await chooseSort("position");
		await page.locator(".inline-comment-filter", { hasText: "Open" }).click();
		await page.waitForTimeout(600);

		expect(await page.evaluate(() => window.__reads)).toBe(0);
		// And the panel really did redraw, rather than sitting inert.
		expect((await quotes())[0]).toContain("first line of the note");
	});
});
