import { matchByContext, matchByHash } from "../anchor";
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
}

/** 1-based line number containing `offset`. */
function lineNumberAt(doc: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < doc.length; i++) {
		if (doc[i] === "\n") line++;
	}
	return line;
}

/**
 * Lines that should carry a highlight, resolved against the current document.
 *
 * Replies are skipped: they have no anchor of their own, so counting them would
 * re-resolve their root's line and keep it marked after the root is resolved.
 */
export function linesWithOpenComments(doc: string, comments: Comment[]): Set<number> {
	const lines = new Set<number>();
	for (const comment of comments) {
		if (comment.resolved || comment.parentId !== null) continue;
		const match = matchByHash(doc, comment.anchor) ?? matchByContext(doc, comment.anchor);
		if (match) lines.add(lineNumberAt(doc, match.from));
	}
	return lines;
}

export function shouldShowMarker(line: number, context: MarkerContext): boolean {
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
