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
	/** The keyboard as Obsidian's mobile app publishes it (`--keyboard-height`), 0 when none. */
	keyboardHeight: number;
	/** Distance from the bottom of the window to the top of the app's own bottom bar. */
	reservedBottom: number;
	/** Height the sheet's own content needs (its `scrollHeight`). */
	contentHeight: number;
}

export interface SheetPosition {
	/** Distance from the bottom of the window to the sheet's bottom edge. */
	bottom: number;
	maxHeight: number;
}

/** The most of the remaining height a sheet may take, so the line stays in view above it. */
export const SHEET_MAX_FRACTION = 0.5;

/**
 * The most of its content a sheet insists on showing when half the space is too
 * little: room for the composer's field and buttons (144px measured on a Pixel
 * 8), not for a whole thread, which can go on scrolling inside the sheet.
 */
export const SHEET_MIN_CAP = 200;

/**
 * Where a bottom sheet sits on a phone.
 *
 * Whichever reaches higher wins: the keyboard or the app's navigation bar. A
 * composer placed against the window alone landed under that bar (#132), and
 * the keyboard covers both when it is up.
 */
export function sheetPosition(metrics: SheetMetrics): SheetPosition {
	// Either source can be the one reporting the keyboard: a browser shrinks the
	// visual viewport, Obsidian's Android app publishes a variable instead (#159).
	const keyboard = Math.max(0, metrics.innerHeight - metrics.visibleHeight, metrics.keyboardHeight);
	const bottom = Math.max(keyboard, metrics.reservedBottom, 0);
	const available = Math.max(0, metrics.innerHeight - bottom);
	// Half the space keeps the commented line in view, until half is too little to
	// type in: in landscape with the keyboard up it left the composer 75px of the
	// 144 it needs (#166). Seeing the field wins over seeing the line then, but
	// never past the space there is.
	const floor = Math.min(metrics.contentHeight, SHEET_MIN_CAP);
	const maxHeight = Math.min(available, Math.max(Math.round(available * SHEET_MAX_FRACTION), floor));
	return { bottom, maxHeight };
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
