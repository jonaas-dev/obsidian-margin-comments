import { gutter, GutterMarker, EditorView, ViewPlugin, type PluginValue } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EDGE_THRESHOLD, isNearLeftEdge, shouldShowMarker } from "./gutter-state";

/** Milliseconds of stillness before the hovered line changes. */
const HOVER_DEBOUNCE_MS = 50;

const GUTTER_CLASS = "inline-comment-gutter";

const setHoveredLine = StateEffect.define<number | null>();
const setCommentedLines = StateEffect.define<Set<number>>();

const hoveredLineField = StateField.define<number | null>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHoveredLine)) return effect.value;
		}
		return value;
	},
});

const commentedLinesField = StateField.define<Set<number>>({
	create: () => new Set(),
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setCommentedLines)) return effect.value;
		}
		return value;
	},
});

class CommentMarker extends GutterMarker {
	constructor(private hasComment: boolean) {
		super();
	}

	eq(other: CommentMarker): boolean {
		return this.hasComment === other.hasComment;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = this.hasComment
			? "inline-comment-marker inline-comment-marker-active"
			: "inline-comment-marker";
		span.setAttribute("aria-label", this.hasComment ? "Comments on this line" : "Add a comment");
		span.textContent = "💬";
		return span;
	}
}

/**
 * Tracks the pointer near the gutter's left edge.
 *
 * The listener lives on scrollDOM rather than the gutter element: the gutter is
 * only as wide as its markers, so while no marker is shown there is nothing wide
 * enough to hover and the affordance could never appear.
 */
class HoverTracker implements PluginValue {
	private timer: number | null = null;
	private current: number | null = null;

	constructor(private view: EditorView) {
		this.onMove = this.onMove.bind(this);
		this.onLeave = this.onLeave.bind(this);
		view.scrollDOM.addEventListener("mousemove", this.onMove);
		view.scrollDOM.addEventListener("mouseleave", this.onLeave);
	}

	private onMove(event: MouseEvent): void {
		// Measure the gutter column rather than the editor's left edge: other
		// plugins and the built-in line numbers sit to our left, so a fixed offset
		// from the editor would miss the marker entirely once they are enabled.
		// CM6 gutters are sticky, so this rect is already in viewport coordinates
		// and must not be adjusted for horizontal scroll.
		const gutters = this.view.dom.querySelector(".cm-gutters");
		const rect = (gutters ?? this.view.scrollDOM).getBoundingClientRect();
		const reach = (gutters ? rect.width : 0) + EDGE_THRESHOLD;

		if (!isNearLeftEdge(event.clientX, rect, reach)) {
			this.schedule(null);
			return;
		}
		const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
		this.schedule(pos === null ? null : this.view.state.doc.lineAt(pos).number);
	}

	private onLeave(): void {
		this.schedule(null);
	}

	/** Debounced so the marker does not flicker while the pointer travels. */
	private schedule(line: number | null): void {
		if (line === this.current) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.current = line;
			this.view.dispatch({ effects: setHoveredLine.of(line) });
		}, HOVER_DEBOUNCE_MS);
	}

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
		this.view.scrollDOM.removeEventListener("mouseleave", this.onLeave);
	}
}

export interface GutterOptions {
	/** True on mobile, where there is no hover to depend on. */
	alwaysVisible: boolean;
	/** Called with the clicked line, 1-based. */
	onActivate: (view: EditorView, line: number) => void;
}

export function commentGutter(options: GutterOptions): Extension {
	return [
		hoveredLineField,
		commentedLinesField,
		ViewPlugin.fromClass(HoverTracker),
		gutter({
			class: GUTTER_CLASS,
			lineMarker(view, line) {
				const number = view.state.doc.lineAt(line.from).number;
				const commented = view.state.field(commentedLinesField);
				const visible = shouldShowMarker(number, {
					hoveredLine: view.state.field(hoveredLineField),
					commented,
					alwaysVisible: options.alwaysVisible,
				});
				return visible ? new CommentMarker(commented.has(number)) : null;
			},
			// Without this the gutter never re-runs lineMarker for our effects: it
			// only recomputes on document and viewport changes, so the hover state
			// would update in the field and never reach the screen.
			lineMarkerChange(update) {
				return (
					update.startState.field(hoveredLineField) !== update.state.field(hoveredLineField) ||
					update.startState.field(commentedLinesField) !== update.state.field(commentedLinesField)
				);
			},
			domEventHandlers: {
				// mousedown is what CM6 reaches for, but the editor claims focus
				// during it and hands it back asynchronously afterwards, so a
				// composer opened here can never keep the caret. Suppressing the
				// default and acting on click instead lets focus settle first.
				mousedown(_view, _line, event) {
					event.preventDefault();
					return true;
				},
				click(view, line, event) {
					event.preventDefault();
					options.onActivate(view, view.state.doc.lineAt(line.from).number);
					return true;
				},
			},
		}),
	];
}

/** Push the set of lines carrying open comments into the editor. */
export function updateCommentedLines(view: EditorView, lines: Set<number>): void {
	view.dispatch({ effects: setCommentedLines.of(lines) });
}
