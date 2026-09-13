/** Pixels between the anchor and the widget. */
export const GAP = 8;

export interface AnchorRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface Size {
	width: number;
	height: number;
}

export type Placement = "right" | "below" | "above";

export interface Position {
	left: number;
	top: number;
	placement: Placement;
}

function clamp(value: number, min: number, max: number): number {
	// max first: when the widget is larger than the viewport, min wins and the
	// widget stays reachable from the top-left rather than being pushed off-screen.
	return Math.max(min, Math.min(value, max));
}

/** What `window` has to offer for measuring the space actually on screen. */
export interface ViewportSource {
	innerWidth: number;
	innerHeight: number;
	visualViewport?: { width: number; height: number } | null;
}

/**
 * The space actually visible, which on a phone is not the window.
 *
 * `window.innerHeight` does not shrink when the on-screen keyboard opens: the
 * layout viewport stays the full height and the keyboard is drawn over it. A
 * composer placed against that measurement is positioned correctly into a region
 * the reader cannot see. `visualViewport` is what reports the part still on
 * screen, and it is absent on old webviews, so the window is the fallback.
 */
export function visibleViewport(source: ViewportSource): Size {
	const visual = source.visualViewport;
	if (!visual) return { width: source.innerWidth, height: source.innerHeight };
	// Never larger than the window: a pinch-zoomed visual viewport reports the
	// magnified region, and trusting that would push the composer off-screen.
	return {
		width: Math.min(visual.width, source.innerWidth),
		height: Math.min(visual.height, source.innerHeight),
	};
}

export interface SheetMetrics {
	/** `window.innerHeight`: the layout viewport, which the keyboard does not shrink. */
	innerHeight: number;
	/** Height still visible above the on-screen keyboard (`visualViewport.height`). */
	visibleHeight: number;
	/** Distance from the bottom of the window to the top of the app's own bottom bar. */
	reservedBottom: number;
}

export interface SheetPosition {
	/** Distance from the bottom of the window to the sheet's bottom edge. */
	bottom: number;
	maxHeight: number;
}

/** The most of the remaining height a sheet may take, so the line stays in view above it. */
export const SHEET_MAX_FRACTION = 0.5;

/**
 * Where a bottom sheet sits on a phone.
 *
 * Whichever reaches higher wins: the keyboard or the app's navigation bar. A
 * composer placed against the window alone landed under that bar (#132), and
 * the keyboard covers both when it is up.
 */
export function sheetPosition(metrics: SheetMetrics): SheetPosition {
	const keyboard = Math.max(0, metrics.innerHeight - metrics.visibleHeight);
	const bottom = Math.max(keyboard, metrics.reservedBottom, 0);
	const available = Math.max(0, metrics.innerHeight - bottom);
	return { bottom, maxHeight: Math.round(available * SHEET_MAX_FRACTION) };
}

/**
 * Place the composer beside the text being commented on.
 *
 * Right is preferred so the anchor stays visible while typing. Below and above
 * are the fallbacks, in that order, because vertical space is the one that runs
 * out on a line near the bottom of the viewport.
 */
export function computePosition(anchor: AnchorRect, widget: Size, viewport: Size): Position {
	const fitsRight = anchor.right + GAP + widget.width <= viewport.width;
	const fitsBelow = anchor.bottom + GAP + widget.height <= viewport.height;

	let placement: Placement;
	let left: number;
	let top: number;

	if (fitsRight) {
		placement = "right";
		left = anchor.right + GAP;
		top = anchor.top;
	} else if (fitsBelow) {
		placement = "below";
		left = anchor.left;
		top = anchor.bottom + GAP;
	} else {
		placement = "above";
		left = anchor.left;
		top = anchor.top - GAP - widget.height;
	}

	return {
		left: clamp(left, 0, Math.max(0, viewport.width - widget.width)),
		top: clamp(top, 0, Math.max(0, viewport.height - widget.height)),
		placement,
	};
}
