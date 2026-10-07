import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";

const NOTE = "note.md";
const BODY = ["alpha beta gamma", "delta epsilon", "eta theta"].join("\n");

interface EditorViewLike {
	state: { doc: { toString(): string } };
}

interface AXNode {
	role?: { value?: string };
	name?: { value?: string };
	ignored?: boolean;
}

/**
 * #84 and #85: what the gutter marker is made of.
 *
 * The marker was an emoji in a `<span>` with an `aria-label`. The emoji could
 * not follow the theme, and the label reached no screen reader — a generic
 * element cannot be named, so the whole thing was invisible to assistive
 * technology while looking correct in the DOM.
 */
describe("the gutter marker", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	/** Hover the gutter beside a line, so the affordance marker appears. */
	async function hoverLine(index: number): Promise<void> {
		const gutters = await page.locator(".cm-gutters").boundingBox();
		const line = await page.locator(".cm-line").nth(index).boundingBox();
		await page.mouse.move(gutters.x + gutters.width / 2, line.y + line.height / 2);
		await page.waitForTimeout(500);
	}

	/** Every name the accessibility tree exposes that mentions comments. */
	async function accessibleNames(): Promise<string[]> {
		const client = await page.context().newCDPSession(page);
		await client.send("Accessibility.enable");
		const { nodes } = (await client.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
		return nodes
			.filter((node) => !node.ignored)
			.map((node) => node.name?.value ?? "")
			.filter((name) => /comment/i.test(name));
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
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("beta");
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + 4,
				"a comment on beta",
			);
		});
		await page.waitForTimeout(1500);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("draws an icon, not a character from the system emoji font (#85)", async () => {
		const drawn = await page.evaluate(() => {
			const marker = document.querySelector(".inline-comment-marker-active") as HTMLElement;
			const svg = marker.querySelector("svg");
			return {
				// setIcon renders nothing at all for a name Obsidian does not ship,
				// so this is also what proves the icon exists in this version.
				paths: svg ? svg.children.length : 0,
				// No text of its own: an emoji lived here, and it is also what a
				// screen reader would read instead of the label.
				text: (marker.textContent ?? "").trim(),
			};
		});
		expect(drawn.paths).toBeGreaterThan(0);
		expect(drawn.text).toBe("");
	});

	it("uses a different icon for 'comment here' than for 'commented' (#85)", async () => {
		// The two states used to be one glyph at two opacities, which reads as the
		// same thing slightly greyer.
		await hoverLine(2);
		const icons: { active: boolean; icon: string }[] = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-marker")).map((marker) => ({
				active: marker.classList.contains("inline-comment-marker-active"),
				icon: marker.querySelector("svg")?.getAttribute("class") ?? "",
			})),
		);

		const active = icons.find((i) => i.active);
		const affordance = icons.find((i) => !i.active);
		expect(active).toBeDefined();
		expect(affordance).toBeDefined();
		expect(active!.icon).not.toBe("");
		expect(affordance!.icon).not.toBe("");
		expect(active!.icon).not.toBe(affordance!.icon);
	});

	it("takes its colour from the theme, not from a palette of its own (#85)", async () => {
		await hoverLine(2);
		// The same assertion the highlight uses: override the variable with a
		// value no theme would choose and demand exactly that back. Comparing two
		// themes would pass for a plugin with its own light and dark entries.
		const painted = await page.evaluate(async () => {
			document.body.style.setProperty("--text-accent", "rgb(1, 2, 3)");
			// The affordance marker only exists while the pointer is on it, so the
			// colour actually on screen is the hover one.
			document.body.style.setProperty("--text-muted", "rgb(7, 8, 9)");
			// Past the colour transition, not just a frame or two: getComputedStyle
			// during one returns the interpolated value, so a correct colour reads
			// back as whatever it is halfway to.
			await new Promise((r) => setTimeout(r, 300));
			const active = document.querySelector(".inline-comment-marker-active") as HTMLElement;
			const affordance = Array.from(document.querySelectorAll(".inline-comment-marker")).find(
				(m) => !m.classList.contains("inline-comment-marker-active"),
			) as HTMLElement;
			const out = {
				active: getComputedStyle(active).color,
				affordance: affordance ? getComputedStyle(affordance).color : "MISSING",
			};
			document.body.style.removeProperty("--text-accent");
			document.body.style.removeProperty("--text-muted");
			return out;
		});

		expect(painted.active).toBe("rgb(1, 2, 3)");
		expect(painted.affordance).toBe("rgb(7, 8, 9)");
	});

	it("says what the line carries, in a tooltip a pointer user gets (#84)", async () => {
		const title = await page.evaluate(
			() =>
				document.querySelector(".inline-comment-marker-active")?.getAttribute("title") ??
				null,
		);
		expect(title).toBe("1 comment on this line");
	});

	it("counts in that tooltip, uncapped, unlike the badge (#84)", async () => {
		// A second thread on the same line, which #75 now allows directly.
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			const leaf = window.app.workspace.getLeavesOfType("markdown")[0];
			const cm = (leaf.view.editor as unknown as { cm: EditorViewLike }).cm;
			const at = cm.state.doc.toString().indexOf("gamma");
			await plugin.routing.createComment(
				cm,
				leaf.view.file.path,
				at,
				at + 5,
				"a second thread",
			);
		});
		await page.waitForTimeout(1500);

		const title = await page.evaluate(
			() =>
				document.querySelector(".inline-comment-marker-active")?.getAttribute("title") ??
				null,
		);
		expect(title).toBe("2 comments on this line");
	});

	it("is hidden from the accessibility tree by CodeMirror, which is why (#84)", async () => {
		// The reason the marker cannot be announced, pinned so nobody spends
		// another afternoon adding roles to it. CodeMirror marks the gutter
		// aria-hidden because it is chrome duplicating the editor's own content.
		const hidden = await page.evaluate(
			() => document.querySelector(".cm-gutters")?.getAttribute("aria-hidden") ?? null,
		);
		expect(hidden).toBe("true");

		// And so nothing inside it reaches the tree, role or no role.
		expect(await accessibleNames()).not.toContain("2 comments on this line");
	});
});
