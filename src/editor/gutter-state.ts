import { resolveMarkers } from "./marker-pass";
import type { Comment } from "../types";

/** Pixels from the gutter's left edge that count as "at the edge". */
export const EDGE_THRESHOLD = 20;

export interface MarkerContext {
	/** Line currently under the pointer, 1-based, or null. */
	hoveredLine: number | null;
	/**
	 * Lines carrying at least one open comment. A membership test rather than a
	 * Set so the gutter can pass the count map straight through.
	 */
	commented: { has(line: number): boolean };
	/** Touch has no hover, so the affordance cannot depend on one. */
	touch: boolean;
	/** Line the caret is on, 1-based. What replaces hover on touch. */
	cursorLine: number | null;
	/** The gutter setting. Off hides every marker, hovered and commented alike. */
	enabled: boolean;
}

/**
 * Lines that should carry a marker, resolved against the current document.
 *
 * A thin read of the shared pass. The editor calls resolveMarkers once and uses
 * both halves; this stays for callers that want only the lines, and for the
 * tests that describe what the lines mean.
 */
export function linesWithOpenComments(doc: string, comments: Comment[]): Set<number> {
	return new Set(resolveMarkers(doc, comments).counts.keys());
}

/** Above this the badge reads "9+": two glyphs is the widest the gutter holds. */
export const MAX_SHOWN_COUNT = 9;

/**
 * What the marker's badge says, or null for no badge.
 *
 * One thread reads as a bare icon: a badge saying "1" tells the reader nothing
 * the icon does not already. The cap keeps the badge to two glyphs, which is
 * what fits inside Obsidian's fixed-width gutter column.
 */
export function countBadgeText(count: number): string | null {
	if (count < 2) return null;
	return count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : `${count}`;
}

/** What a screen reader hears, which is where the exact number always goes. */
export function markerLabel(count: number): string {
	if (count === 0) return "Add a comment";
	if (count === 1) return "1 comment on this line";
	return `${count} comments on this line`;
}

export function shouldShowMarker(line: number, context: MarkerContext): boolean {
	// Checked before anything else, touch included: the setting answers whether
	// the reader wants markers at all, not when one appears.
	if (!context.enabled) return false;
	if (context.commented.has(line)) return true;
	// The caret's line rather than every line. Marking all of them was what
	// "always visible" meant, and it puts a speech bubble beside every line of
	// the note — the affordance stops reading as "something is here".
	if (context.touch) return context.cursorLine === line;
	return context.hoveredLine === line;
}

export function isNearLeftEdge(
	clientX: number,
	rect: { left: number; width: number },
	threshold = EDGE_THRESHOLD,
): boolean {
	const offset = clientX - rect.left;
	return offset >= 0 && offset < threshold;
}
