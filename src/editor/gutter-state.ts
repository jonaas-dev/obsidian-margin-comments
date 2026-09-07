import { resolveMarkers } from "./marker-pass";
import type { Comment } from "../types";

/** Pixels from the gutter's left edge that count as "at the edge". */
export const EDGE_THRESHOLD = 20;

export interface MarkerContext {
	/** Line currently under the pointer, 1-based, or null. */
	hoveredLine: number | null;
	/** Lines carrying at least one open comment. */
	commented: Set<number>;
	/** Mobile has no hover, so the affordance cannot depend on one. */
	alwaysVisible: boolean;
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
	return resolveMarkers(doc, comments).lines;
}

export function shouldShowMarker(line: number, context: MarkerContext): boolean {
	// Checked before anything else, mobile included: "always visible" answers
	// when a marker appears, not whether the reader wants markers at all.
	if (!context.enabled) return false;
	if (context.alwaysVisible) return true;
	if (context.commented.has(line)) return true;
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
