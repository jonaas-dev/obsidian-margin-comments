import { gutter, GutterMarker, EditorView, ViewPlugin, type PluginValue } from "@codemirror/view";
import { setIcon } from "obsidian";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
	countBadgeText,
	EDGE_THRESHOLD,
	isNearLeftEdge,
	markerLabel,
	shouldShowMarker,
} from "./gutter-state";

/** Milliseconds of stillness before the hovered line changes. */
const HOVER_DEBOUNCE_MS = 50;

const GUTTER_CLASS = "inline-comment-gutter";

/** A line that carries comments. The same family as the ribbon and the panel. */
const MARKER_ICON = "message-square";
/** The affordance: a bubble with a plus, which is what the click does. */
const ADD_ICON = "message-square-plus";

const setHoveredLine = StateEffect.define<number | null>();
const setCommentedLines = StateEffect.define<Map<number, number>>();
const setGutterEnabled = StateEffect.define<boolean>();
const setCountEnabled = StateEffect.define<boolean>();

const hoveredLineField = StateField.define<number | null>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHoveredLine)) return effect.value;
		}
		return value;
	},
});

const commentedLinesField = StateField.define<Map<number, number>>({
	create: () => new Map(),
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setCommentedLines)) return effect.value;
		}
		return value;
	},
});

/**
 * The gutter setting, in editor state rather than read from the plugin.
 *
 * A CodeMirror extension is built once and lives as long as the editor, so a
 * value captured at construction never changes. Pushing it through an effect is
 * what lets the setting take hold without reopening the note — the same reason
 * the commented lines travel this way.
 */
const gutterEnabledField = StateField.define<boolean>({
	create: () => true,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setGutterEnabled)) return effect.value;
		}
		return value;
	},
});

/**
 * The gutter setting for the count, in editor state for the same reason as the
 * gutter's own: an extension built once never sees a value captured at
 * construction change.
 */
const countEnabledField = StateField.define<boolean>({
	create: () => true,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setCountEnabled)) return effect.value;
		}
		return value;
	},
});

class CommentMarker extends GutterMarker {
	constructor(
		private count: number,
		private showCount: boolean,
	) {
		super();
	}

	/**
	 * Both, not just whether the line is commented: without the count here a
	 * line going from two threads to three would keep the marker CodeMirror
	 * already has, and the badge would go stale in the open editor.
	 */
	eq(other: CommentMarker): boolean {
		return this.count === other.count && this.showCount === other.showCount;
	}

	toDOM(): HTMLElement {
		const commented = this.count > 0;
		const span = document.createElement("span");
		span.className = commented
			? "inline-comment-marker inline-comment-marker-active"
			: "inline-comment-marker";

		// A tooltip, not an aria-label. The label this used to carry reached no
		// screen reader at all, and no role can fix that: CodeMirror marks the
		// whole gutter `aria-hidden="true"`, so nothing inside it is in the
		// accessibility tree. Measured — the tree held no node for the marker
		// even with role="img" on it (#84). A title is what a pointer user
		// actually gets, and the panel is the surface a screen reader reads.
		span.setAttribute("title", markerLabel(this.count));

		// Obsidian's own icons rather than an emoji (#85): an emoji is painted by
		// the system font in its own colours, so it cannot follow the theme, and
		// it is drawn differently on every platform. The two states differ by
		// glyph and colour rather than by opacity — "you may comment here" and
		// "there are comments here" are different things.
		const icon = span.createSpan({ cls: "inline-comment-marker-icon" });
		setIcon(icon, commented ? MARKER_ICON : ADD_ICON);

		const badge = this.showCount ? countBadgeText(this.count) : null;
		if (badge !== null) span.createSpan({ cls: "inline-comment-marker-count", text: badge });
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
	/**
	 * Whether this is a touch device, where there is no hover to depend on.
	 *
	 * A function, read at paint time. A CodeMirror extension is built once and
	 * outlives every value handed to it at construction — the same reason the
	 * gutter setting travels as an effect rather than a captured boolean.
	 * `Platform.isMobile` does not change under a user, but a value that cannot
	 * change is also a value no test can vary.
	 */
	touch: () => boolean;
	/** Called with the clicked line, 1-based. */
	onActivate: (view: EditorView, line: number) => void;
}

export function commentGutter(options: GutterOptions): Extension {
	return [
		hoveredLineField,
		commentedLinesField,
		gutterEnabledField,
		countEnabledField,
		ViewPlugin.fromClass(HoverTracker),
		gutter({
			class: GUTTER_CLASS,
			lineMarker(view, line) {
				const number = view.state.doc.lineAt(line.from).number;
				const commented = view.state.field(commentedLinesField);
				const touch = options.touch();
				const visible = shouldShowMarker(number, {
					hoveredLine: view.state.field(hoveredLineField),
					commented,
					touch,
					cursorLine: touch
						? view.state.doc.lineAt(view.state.selection.main.head).number
						: null,
					enabled: view.state.field(gutterEnabledField),
				});
				return visible
					? new CommentMarker(commented.get(number) ?? 0, view.state.field(countEnabledField))
					: null;
			},
			// Without this the gutter never re-runs lineMarker for our effects: it
			// only recomputes on document and viewport changes, so the hover state
			// would update in the field and never reach the screen.
			lineMarkerChange(update) {
				// The caret only drives a marker on touch, so only there is a
				// selection change worth a gutter rebuild. On desktop this runs on
				// every cursor move, which is the path #31 went to trouble to keep
				// off the keystroke.
				if (options.touch() && update.selectionSet) return true;
				return (
					update.startState.field(hoveredLineField) !== update.state.field(hoveredLineField) ||
					update.startState.field(commentedLinesField) !==
						update.state.field(commentedLinesField) ||
					update.startState.field(gutterEnabledField) !== update.state.field(gutterEnabledField) ||
					update.startState.field(countEnabledField) !== update.state.field(countEnabledField)
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

/** Push the gutter setting into the editor, so it applies without a reload. */
export function updateGutterEnabled(view: EditorView, enabled: boolean): void {
	view.dispatch({ effects: setGutterEnabled.of(enabled) });
}

/** Push the count setting into the editor, so it applies without a reload. */
export function updateCountEnabled(view: EditorView, enabled: boolean): void {
	view.dispatch({ effects: setCountEnabled.of(enabled) });
}

/** Push each commented line's open thread count into the editor. */
export function updateCommentedLines(view: EditorView, counts: Map<number, number>): void {
	view.dispatch({ effects: setCommentedLines.of(counts) });
}
