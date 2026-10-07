import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { resolveMarkers, type LineRange } from "./marker-pass";
import type { Comment } from "../types";

export type { LineRange } from "./marker-pass";

/**
 * Line spans that should be tinted, resolved against the current document.
 *
 * A thin read of the shared pass, for the same reason as linesWithOpenComments.
 */
export function highlightRanges(doc: string, comments: Comment[]): LineRange[] {
	return resolveMarkers(doc, comments).lines;
}

/** The anchored spans that should be marked, resolved the same way. */
export function markedRanges(doc: string, comments: Comment[]): LineRange[] {
	return resolveMarkers(doc, comments).ranges;
}

interface Highlights {
	/** Whole lines to tint, for comments made on a line. */
	lines: LineRange[];
	/** Anchored spans to mark, for comments made on a selection. */
	ranges: LineRange[];
}

const setHighlights = StateEffect.define<Highlights>();

const lineDecoration = Decoration.line({ class: "inline-comment-active-line" });
const markDecoration = Decoration.mark({ class: "inline-comment-active-range" });

/**
 * Two layers, deliberately.
 *
 * A whole-line comment tints its line; a comment on a selection marks that
 * selection and nothing more. A line carrying both shows both, the mark reading
 * over the tint (#100). One decoration that changed shape depending on the kind
 * of anchor would make a line comment and a selection comment look like the
 * same thing.
 *
 * They live in a StateField rather than a view plugin so they survive outside
 * the viewport: scrolling a commented line back into view must not depend on
 * the decoration having been rebuilt while it was off-screen.
 */
const highlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHighlights)) {
				// Line decorations take the line's start; marks take their span.
				// Sorted together because CodeMirror requires document order
				// across the whole set, not within each kind.
				const all = [
					...effect.value.lines.map((line) => lineDecoration.range(line.from)),
					...effect.value.ranges.map((range) =>
						markDecoration.range(range.from, range.to),
					),
				].sort((a, b) => a.from - b.from || a.to - b.to);
				return Decoration.set(all, true);
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

export function updateHighlights(view: EditorView, highlights: Highlights): void {
	view.dispatch({ effects: setHighlights.of(highlights) });
}
