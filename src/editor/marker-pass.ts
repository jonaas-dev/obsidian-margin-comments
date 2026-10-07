import { matchAnchor } from "../anchor";
import type { Comment } from "../types";

export interface LineRange {
	from: number;
	to: number;
}

/** Everything the editor decorations need, from one walk over the comments. */
interface MarkerPass {
	/**
	 * How many open threads each 1-based line carries.
	 *
	 * A count rather than a set of lines because the gutter marker has to tell
	 * one thread from several without the panel being open (#68), and the count
	 * falls out of the walk the pass already makes. Every key carries at least
	 * one thread, so the keys are still "the commented lines".
	 */
	counts: Map<number, number>;
	/**
	 * One span per line carrying a whole-line comment, in document order.
	 *
	 * Only whole-line comments. A comment made on a selection marks that
	 * selection instead (#100): tinting its whole line claimed the comment was
	 * about all of it, which is the claim reading mode already refuses to make.
	 */
	lines: LineRange[];
	/**
	 * The anchored span of each comment made on a selection, in document order,
	 * with overlaps merged.
	 *
	 * Merged because two marks over the same characters nest, and two tints add
	 * up into a darker band that reads as a state nobody defined — the same
	 * reason the line spans are keyed by line.
	 */
	ranges: LineRange[];
}

/** Spans in document order, with anything overlapping or touching joined. */
function mergeRanges(spans: LineRange[]): LineRange[] {
	const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
	const merged: LineRange[] = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
		else merged.push({ ...span });
	}
	return merged;
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
	const counts = new Map<number, number>();
	// Keyed by line start: two line comments on one line must not stack two
	// tints, which reads as a different, darker state rather than as two
	// comments.
	const lines = new Map<number, LineRange>();
	const ranges: LineRange[] = [];

	for (const comment of comments) {
		if (comment.resolved || comment.parentId !== null) continue;
		// Stages 1 and 2 only. Stage 3 is the panel's to pay.
		const match = matchAnchor(doc, comment.anchor);
		if (!match) continue;

		const index = lineIndexAt(starts, match.from);
		counts.set(index + 1, (counts.get(index + 1) ?? 0) + 1);

		if (comment.anchor.isLineComment) {
			const from = starts[index];
			const to = index + 1 < starts.length ? starts[index + 1] - 1 : doc.length;
			lines.set(from, { from, to });
		} else {
			ranges.push({ from: match.from, to: match.to });
		}
	}

	return {
		counts,
		// CodeMirror requires ranges in document order.
		lines: [...lines.values()].sort((a, b) => a.from - b.from),
		ranges: mergeRanges(ranges),
	};
}
