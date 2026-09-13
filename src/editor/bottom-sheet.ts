import { GAP, sheetPosition } from "./floating-position";

/**
 * Space Obsidian keeps at the bottom of a phone screen for its navigation bar.
 *
 * Measured rather than read from a CSS variable: the bar floats with a margin no
 * single variable describes, and it is gone while the keyboard is up. Not
 * `isShown()`, which Obsidian documents as unreliable for fixed elements.
 */
export function reservedBottom(doc: Document = document, win: Window = window): number {
	const bar = doc.querySelector(".mobile-navbar");
	if (!(bar instanceof HTMLElement)) return 0;
	const style = win.getComputedStyle(bar);
	const rect = bar.getBoundingClientRect();
	if (style.display === "none" || style.visibility === "hidden" || rect.height === 0) return 0;
	return Math.max(0, Math.round(win.innerHeight - rect.top + GAP));
}

/** Pin a composer or popover to the bottom of the screen as a sheet. */
export function placeSheet(el: HTMLElement, win: Window = window): void {
	const visual = win.visualViewport;
	const { bottom, maxHeight } = sheetPosition({
		innerHeight: win.innerHeight,
		visibleHeight: visual ? visual.height : win.innerHeight,
		reservedBottom: reservedBottom(win.document, win),
	});
	el.addClass("is-sheet");
	el.style.left = "";
	el.style.top = "";
	el.style.bottom = `${bottom}px`;
	el.style.maxHeight = `${maxHeight}px`;
	el.dataset.placement = "sheet";
}
