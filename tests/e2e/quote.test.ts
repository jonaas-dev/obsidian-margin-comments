import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const LONG = "dsddd".repeat(90);
const BODY = [
	"# Encabezado",
	"",
	"Un párrafo con la palabra objetivo en medio de la frase.",
	"",
	"",
	"Otro párrafo para tener contexto alrededor de la línea vacía.",
	LONG,
].join("\n");

/**
 * #97 and #98: what the card quotes.
 *
 * An empty line has no text to quote and used to render the blank. A long
 * selection had no bound and left the card.
 */
describe("the quoted text", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function commentOn(needle: string | null, line: number, text: string): Promise<void> {
		await page.evaluate(
			async ([n, ln, body]: [string | null, number, string]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (leaf.view.editor as unknown as {
					cm: { state: { doc: { toString(): string; line(n: number): { from: number } } } };
				}).cm;
				const doc = cm.state.doc.toString();
				const from = n === null ? cm.state.doc.line(ln).from : doc.indexOf(n);
				const to = n === null ? from : from + n.length;
				await plugin.createComment(cm, leaf.view.file.path, from, to, body);
			},
			[needle, line, text],
		);
		await page.waitForTimeout(1200);
	}

	const quotes = (): Promise<{ text: string; h: number; right: number; cardRight: number }[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-quote")).map((q) => {
				const card = q.closest(".inline-comment-card") as HTMLElement;
				return {
					text: (q.textContent ?? "").trim(),
					h: Math.round(q.getBoundingClientRect().height),
					right: Math.round(q.getBoundingClientRect().right),
					cardRight: Math.round(card.getBoundingClientRect().right),
				};
			}),
		);

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

		await commentOn("objetivo", 3, "Sobre una palabra.");
		await commentOn(null, 5, "Sobre una línea vacía.");
		await commentOn(LONG, 7, "Sobre una selección larguísima.");
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel", { timeout: 10000 });
	}, 300000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("names the empty line instead of quoting nothing (#97)", async () => {
		const all = await quotes();
		const blank = all.filter((q) => q.text === "");
		expect(blank).toEqual([]);

		// The harness runs an English install, so this is the fallback. The
		// language map itself is unit-tested.
		expect(all.map((q) => q.text)).toContain("Empty line");
	});

	it("says the same thing to a screen reader (#97)", async () => {
		// The accessible name used to come out as `Go to "" in the note`.
		const labels: (string | null)[] = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-quote")).map((q) =>
				q.getAttribute("aria-label"),
			),
		);
		expect(labels.some((l) => l === 'Go to "" in the note')).toBe(false);
		expect(labels).toContain("Go to the empty line in the note");
	});

	it("keeps a 450-character quote inside the card (#98)", async () => {
		const all = await quotes();
		const longest = all.reduce((a, b) => (a.h > b.h ? a : b));

		// It used to reach past the card's edge: measured, a 256px box with a
		// scrollWidth of 2834px.
		expect(longest.right).toBeLessThanOrEqual(longest.cardRight);
		// And bounded: one line, not a wall of text down the card.
		expect(longest.h).toBeLessThan(60);
	});

	it("ends a clamped quote in an ellipsis and keeps the rest in the tooltip (#98)", async () => {
		const clamped = await page.evaluate(() => {
			const el = Array.from(document.querySelectorAll(".inline-comment-quote")).find(
				(q) => (q.textContent ?? "").trim().length > 100,
			) as HTMLElement;
			const text = el.querySelector(".inline-comment-quote-text") as HTMLElement;
			const cs = getComputedStyle(text);
			return {
				clipped: text.scrollWidth > text.clientWidth + 1,
				ellipsis: cs.textOverflow,
				title: (el.getAttribute("title") ?? "").length,
			};
		});
		expect(clamped.clipped).toBe(true);
		expect(clamped.ellipsis).toBe("ellipsis");
		// The whole selection stays reachable, since the visible quote is cut.
		expect(clamped.title).toBe(450);
	});

	it("follows the line once an empty one is written on (#115)", async () => {
		// "Empty line" is a placeholder this plugin invented, not the reader's
		// words. Measured before: the line read "Ahora esta linea tiene texto"
		// and the card still said "Empty line".
		await page.evaluate(() => {
			const editor = window.app.workspace.getLeavesOfType("markdown")[0].view.editor!;
			editor.replaceRange("Ahora la línea tiene texto", { line: 4, ch: 0 }, { line: 4, ch: 0 });
		});
		await page.waitForTimeout(1600);

		const texts = (await quotes()).map((q) => q.text);
		expect(texts).not.toContain("Empty line");
		expect(texts).toContain("Ahora la línea tiene texto");
	});

	it("follows a phrase that was rewritten under the comment (#115)", async () => {
		// The case that proves this is not only about the placeholder: the quote
		// came from the stored anchor, so a comment the re-anchoring found again
		// still quoted the words it used to sit on.
		//
		// One letter inside a long phrase, deliberately: destroying the text
		// outright orphans the comment, which is a different case with a
		// different right answer (below). This edit is small enough that the
		// anchor survives and lands on text that now reads differently.
		await commentOn("tener contexto alrededor", 6, "Sobre una frase larga.");
		expect((await quotes()).map((q) => q.text)).toContain("tener contexto alrededor");

		await page.evaluate(() => {
			const editor = window.app.workspace.getLeavesOfType("markdown")[0].view.editor!;
			const line = editor.getLine(5);
			editor.replaceRange(line.replace("contexto", "contexta"), { line: 5, ch: 0 }, { line: 5, ch: line.length });
		});
		await page.waitForTimeout(1800);

		const texts = (await quotes()).map((q) => q.text);
		expect(texts).toContain("tener contexta alrededor");
		expect(texts).not.toContain("tener contexto alrededor");

		// And it is still anchored, not orphaned — otherwise the assertion above
		// would be about the fallback rather than about the live slice.
		const orphans = await page.evaluate(
			() => document.querySelectorAll(".inline-comment-card.is-orphaned").length,
		);
		expect(orphans).toBe(0);
	});

	it("keeps the stored words on an orphaned thread (#115)", async () => {
		// There is no current span to read, and that card already explains
		// itself. Showing nothing there would be worse than showing history.
		await page.evaluate(() => {
			const editor = window.app.workspace.getLeavesOfType("markdown")[0].view.editor!;
			const line = editor.getLine(2);
			editor.replaceRange("Nada de esto se parece a lo que había antes aquí.", { line: 2, ch: 0 }, { line: 2, ch: line.length });
		});
		await page.waitForTimeout(1800);

		const orphaned: string[] = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-card.is-orphaned")).map((c) =>
				(c.querySelector(".inline-comment-quote")?.textContent ?? "").trim(),
			),
		);
		expect(orphaned.length).toBeGreaterThan(0);
		expect(orphaned.every((t) => t.length > 0)).toBe(true);
	});

	it("gives a short quote no tooltip clutter it does not need", async () => {
		// Every quote carrying a title would put a tooltip on text that is fully
		// visible, which is noise.
		const short = await page.evaluate(() => {
			const el = Array.from(document.querySelectorAll(".inline-comment-quote")).find(
				(q) => (q.textContent ?? "").trim() === "objetivo",
			) as HTMLElement;
			const text = el.querySelector(".inline-comment-quote-text") as HTMLElement;
			return { clipped: text.scrollWidth > text.clientWidth + 1 };
		});
		expect(short.clipped).toBe(false);
	});
});
