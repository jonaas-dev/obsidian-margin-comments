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
	// The bar hides by sliding below the screen while still displayed, and from
	// there the gap below still counted it as a few pixels of bar (#160).
	if (rect.top >= win.innerHeight) return 0;
	return Math.max(0, Math.round(win.innerHeight - rect.top + GAP));
}

/**
 * The on-screen keyboard as Obsidian's mobile app reports it.
 *
 * On Android the app keeps the keyboard from shrinking the visual viewport: it
 * publishes the height as `--keyboard-height` on the root element and shrinks
 * its own container instead. A sheet that trusted the viewport alone opened
 * behind the keyboard (#159).
 */
export function keyboardHeight(doc: Document = document, win: Window = window): number {
	const value = Number.parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue("--keyboard-height"));
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Pin a composer or popover to the bottom of the screen as a sheet. */
export function placeSheet(el: HTMLElement, win: Window = window): void {
	const visual = win.visualViewport;
	const { bottom, maxHeight } = sheetPosition({
		innerHeight: win.innerHeight,
		visibleHeight: visual ? visual.height : win.innerHeight,
		keyboardHeight: keyboardHeight(win.document, win),
		reservedBottom: reservedBottom(win.document, win),
		// With its border: max-height counts the border and scrollHeight does not,
		// and that 1px left the composer scrolling inside itself.
		contentHeight: el.scrollHeight + el.offsetHeight - el.clientHeight,
	});
	el.addClass("is-sheet");
	// Removed rather than set to "": a sheet is positioned from the bottom, and
	// leaving an inline left/top behind would fight the rules that place it.
	el.style.removeProperty("left");
	el.style.removeProperty("top");
	el.style.bottom = `${bottom}px`;
	el.style.maxHeight = `${maxHeight}px`;
	el.dataset.placement = "sheet";
}

/**
 * Call `onChange` whenever the space a floating widget is placed in may have moved.
 *
 * A browser reports the keyboard through `visualViewport`. Obsidian's mobile app
 * reports it by rewriting the root element's style, and hides its navigation bar
 * by toggling a body class and sliding the bar away, so both are watched too.
 * The slide is waited out as well: when the class changes the bar has not moved
 * yet. Returns the function that stops watching.
 */
export function watchPlacement(onChange: () => void, win: Window = window): () => void {
	const doc = win.document;
	const visual = win.visualViewport;
	visual?.addEventListener("resize", onChange);
	visual?.addEventListener("scroll", onChange);
	const observer = new MutationObserver(onChange);
	observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
	observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
	const onTransitionEnd = (event: TransitionEvent): void => {
		if (event.target instanceof Element && event.target.matches(".mobile-navbar")) onChange();
	};
	doc.addEventListener("transitionend", onTransitionEnd, true);
	return () => {
		visual?.removeEventListener("resize", onChange);
		visual?.removeEventListener("scroll", onChange);
		observer.disconnect();
		doc.removeEventListener("transitionend", onTransitionEnd, true);
	};
}
