import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { resolveMarkers, type LineRange } from "./marker-pass";
import type { Comment } from "../types";

export type { LineRange };

/**
 * Line spans that should be highlighted, resolved against the current document.
 *
 * A thin read of the shared pass, for the same reason as linesWithOpenComments.
 */
export function highlightRanges(doc: string, comments: Comment[]): LineRange[] {
	return resolveMarkers(doc, comments).ranges;
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
