import { matchAnchor } from "../anchor";
import type { Comment } from "../types";

export interface LineRange {
	from: number;
	to: number;
}

/** Everything the editor decorations need, from one walk over the comments. */
export interface MarkerPass {
	/** 1-based lines carrying at least one open comment. */
	lines: Set<number>;
	/** One span per highlighted line, in document order. */
	ranges: LineRange[];
}

/**
 * Offsets where each line begins, so a position can be turned into a line
 * number without walking the document again.
 *
 * This is what makes the pass linear. Resolving each comment's line by counting
 * newlines from the start of the note is O(document) per comment, and with 200
 * comments on a 10,000-line note that scan — not the matching — was 44 ms of
 * the 61 ms the gutter cost on every keystroke.
 */
function lineStarts(doc: string): number[] {
	const starts = [0];
	for (let i = 0; i < doc.length; i++) {
		if (doc[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

/** Index of the line containing `offset`, by binary search over line starts. */
function lineIndexAt(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= offset) low = mid;
		else high = mid - 1;
	}
	return low;
}

/**
 * Resolve every open comment against the document once.
 *
 * One pass rather than two: the gutter and the highlights both need the same
 * anchor matches, and running `matchAnchor` for each of them meant paying for
 * every comment twice on a path that used to run on every keystroke.
 *
 * Replies are skipped throughout: they carry their root's anchor, so counting
 * them would re-resolve the root's line and keep it marked after the root has
 * been resolved.
 */
export function resolveMarkers(doc: string, comments: Comment[]): MarkerPass {
	const starts = lineStarts(doc);
	const lines = new Set<number>();
	// Keyed by line start: two comments on one line must not stack two tints,
	// which reads as a different, darker state rather than as two comments.
	const ranges = new Map<number, LineRange>();

	for (const comment of comments) {
		if (comment.resolved || comment.parentId !== null) continue;
		// Stages 1 and 2 only. Stage 3 is the panel's to pay.
		const match = matchAnchor(doc, comment.anchor);
		if (!match) continue;

		const index = lineIndexAt(starts, match.from);
		lines.add(index + 1);
		const from = starts[index];
		const to = index + 1 < starts.length ? starts[index + 1] - 1 : doc.length;
		ranges.set(from, { from, to });
	}

	return {
		lines,
		// CodeMirror requires ranges in document order.
		ranges: [...ranges.values()].sort((a, b) => a.from - b.from),
	};
}
