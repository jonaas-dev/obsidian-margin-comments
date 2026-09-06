import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { matchByContext, matchByHash } from "../anchor";
import type { Comment } from "../types";

export interface LineRange {
	from: number;
	to: number;
}

function lineRangeAt(doc: string, offset: number): LineRange {
	const from = doc.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const next = doc.indexOf("\n", offset);
	return { from, to: next === -1 ? doc.length : next };
}

/**
 * Line spans that should be highlighted, resolved against the current document.
 *
 * One range per line, not per comment: two decorations on the same line stack
 * their background tint and read as a different, darker state. Replies are
 * skipped since they share their root's anchor.
 */
export function highlightRanges(doc: string, comments: Comment[]): LineRange[] {
	const starts = new Map<number, LineRange>();
	for (const comment of comments) {
		if (comment.resolved || comment.parentId !== null) continue;
		const match = matchByHash(doc, comment.anchor) ?? matchByContext(doc, comment.anchor);
		if (!match) continue;
		const range = lineRangeAt(doc, match.from);
		starts.set(range.from, range);
	}
	// CodeMirror requires ranges in document order.
	return [...starts.values()].sort((a, b) => a.from - b.from);
}

const setHighlights = StateEffect.define<LineRange[]>();

const lineDecoration = Decoration.line({ class: "inline-comment-active-line" });

/**
 * Highlights live in a StateField rather than a view plugin so they survive
 * outside the viewport: scrolling a commented line back into view must not
 * depend on the decoration having been rebuilt while it was off-screen.
 */
const highlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHighlights)) {
				return Decoration.set(
					effect.value.map((range) => lineDecoration.range(range.from)),
					true,
				);
			}
		}
		// Map through document changes so the highlight tracks edits until the
		// next re-anchor pass arrives.
		return decorations.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});

export function lineHighlights(): Extension {
	return [highlightField];
}

export function updateHighlights(view: EditorView, ranges: LineRange[]): void {
	view.dispatch({ effects: setHighlights.of(ranges) });
}
