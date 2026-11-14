import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = [
	"Un párrafo con la palabra objetivo en medio de la frase.",
	"Una línea entera que se comenta sin seleccionar nada.",
	"Una tercera línea con dos palabras: alfa y omega, comentadas.",
	"Una cuarta línea con ==texto resaltado== de Obsidian.",
].join("\n");

/**
 * #100: two layers, and the weights are the point.
 *
 * A whole-line comment tints its line; a comment on a selection marks that
 * selection and nothing more. A line carrying both shows both.
 */
describe("the editor's highlight layers", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	async function commentOn(needle: string | null, line: number, body: string): Promise<void> {
		await page.evaluate(
			async ([n, ln, text]: [string | null, number, string]) => {
				const plugin = window.app.plugins.plugins["margin-comments"];
				const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
				const cm = (
					leaf.view.editor as unknown as {
						cm: {
							state: {
								doc: { toString(): string; line(n: number): { from: number } };
							};
						};
					}
				).cm;
				const doc = cm.state.doc.toString();
				const from = n === null ? cm.state.doc.line(ln).from : doc.indexOf(n);
				const to = n === null ? from : from + n.length;
				await plugin.routing.createComment(cm, leaf.view.file.path, from, to, text);
			},
			[needle, line, body],
		);
		await page.waitForTimeout(1200);
	}

	const layers = (): Promise<{ lines: string[]; marks: string[] }> =>
		page.evaluate(() => ({
			lines: Array.from(document.querySelectorAll(".inline-comment-active-line")).map((el) =>
				(el.textContent ?? "").slice(0, 30),
			),
			marks: Array.from(document.querySelectorAll(".inline-comment-active-range")).map(
				(el) => el.textContent ?? "",
			),
		}));

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
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("marks the selected word and leaves the rest of the line alone", async () => {
		await commentOn("objetivo", 1, "Sobre una palabra.");
		const seen = await layers();

		expect(seen.marks).toEqual(["objetivo"]);
		// The report: the whole line used to be tinted for a word comment.
		expect(seen.lines).toEqual([]);
	});

	it("tints the line for a comment made without a selection", async () => {
		await commentOn(null, 2, "Sobre la línea entera.");
		const seen = await layers();

		expect(seen.lines.some((l) => l.startsWith("Una línea entera"))).toBe(true);
		// And it did not add a mark: there is no selection to mark.
		expect(seen.marks).toEqual(["objetivo"]);
	});

	it("shows both on a line that carries both", async () => {
		await commentOn(null, 1, "Y ahora también la línea entera.");
		const seen = await layers();

		expect(seen.marks).toContain("objetivo");
		expect(seen.lines.some((l) => l.startsWith("Un párrafo con la palabra"))).toBe(true);
	});

	it("reads the mark as stronger than the tint", async () => {
		// Different colours, not the same tint twice: the mark names particular
		// words and has to be legible over the line it sits on.
		const weights = await page.evaluate(() => {
			const line = document.querySelector(".inline-comment-active-line") as HTMLElement;
			const mark = document.querySelector(".inline-comment-active-range") as HTMLElement;
			return {
				line: getComputedStyle(line).backgroundColor,
				mark: getComputedStyle(mark).backgroundColor,
			};
		});
		expect(weights.mark).not.toBe(weights.line);
	});

	it("takes the mark's colour from the theme", async () => {
		// Overridden with a value no theme would choose and demanded back, the
		// way the line highlight is already guarded.
		const painted = await page.evaluate(async () => {
			document.body.style.setProperty("--text-accent", "rgb(1, 2, 3)");
			await new Promise((r) => setTimeout(r, 300));
			const mark = document.querySelector(".inline-comment-active-range") as HTMLElement;
			const shadow = getComputedStyle(mark).boxShadow;
			document.body.style.removeProperty("--text-accent");
			return shadow;
		});
		expect(painted).toContain("rgb(1, 2, 3)");
	});

	it("does not stack two marks over the same words into a darker band", async () => {
		await commentOn("objetivo", 1, "Un segundo hilo sobre la misma palabra.");
		const stacked = await page.evaluate(() => {
			const marks = Array.from(
				document.querySelectorAll(".inline-comment-active-range"),
			) as HTMLElement[];
			const onTarget = marks.filter((m) => (m.textContent ?? "").includes("objetivo"));
			return {
				count: onTarget.length,
				nested: onTarget.some(
					(m) => m.querySelector(".inline-comment-active-range") !== null,
				),
			};
		});
		expect(stacked).toEqual({ count: 1, nested: false });
	});

	it("refuses an invalid span and stores nothing (#423)", async () => {
		const stored = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (
				leaf.view.editor as unknown as { cm: { state: { doc: { length: number } } } }
			).cm;
			const path = leaf.view.file.path;
			const count = async () => (await plugin.storage.getCommentsForFile(path)).length;
			const before = await count();
			const len = cm.state.doc.length;
			for (const [from, to] of [
				[-1, 3],
				[5, 2],
				[len - 2, len + 5],
			]) {
				await plugin.routing.createComment(cm, path, from, to, "invalid");
			}
			return (await count()) - before;
		});
		expect(stored).toBe(0);
	});

	for (const theme of ["theme-light", "theme-dark"]) {
		it(`draws no tint over an Obsidian highlight, ${theme} (#423)`, async () => {
			await commentOn("resaltado", 4, "Sobre texto resaltado.");
			const seen = await page.evaluate(async (t: string) => {
				document.body.classList.remove("theme-light", "theme-dark");
				document.body.classList.add(t);
				// Past the colour transitions before reading computed values.
				await new Promise((r) => setTimeout(r, 800));
				const marks = Array.from(
					document.querySelectorAll(".inline-comment-active-range"),
				) as HTMLElement[];
				const inside = marks.filter(
					(m) => m.closest(".cm-highlight") || m.querySelector(".cm-highlight"),
				);
				return inside.map((m) => ({
					bg: getComputedStyle(m).backgroundColor,
					shadow: getComputedStyle(m).boxShadow,
				}));
			}, theme);
			expect(seen.length).toBeGreaterThan(0);
			for (const m of seen) {
				expect(m.bg).toBe("rgba(0, 0, 0, 0)");
				expect(m.shadow).not.toBe("none");
			}
		});
	}

	it("clears both layers when the setting is switched off", async () => {
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.settings.showLineHighlights = false;
			await plugin.refresh();
		});
		await page.waitForTimeout(900);
		expect(await layers()).toEqual({ lines: [], marks: [] });
	});
});
