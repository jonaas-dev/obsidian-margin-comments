import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { threadSpansField } from "./line-highlight";
import { appearances, type ReadingHighlight } from "../reading/reading-highlights";
import {
	clearReadingMarks,
	markBlock,
	paintReadingMarks,
	unmarkBlock,
	READING_MARK_CLASS,
} from "../reading/reading-marks";

/** The blocks live preview renders as one widget, over which decorations reach no DOM. */
const WIDGETS = ".cm-table-widget, .cm-callout";

/** What a widget was last painted with, so an untouched one is not repainted. */
const PAINTED = "inlineCommentPainted";

/**
 * Comment marks inside rendered tables and callouts (#419).
 *
 * Obsidian replaces those blocks with a widget, so the mark and line
 * decorations of lineHighlights land on no DOM. The widget is rendered HTML,
 * which is the problem reading mode already solves, so its painter marks the
 * words, or the whole block for a line comment or text the renderer consumed,
 * and its click handler opens the thread from either.
 *
 * Fed from threadSpansField, never from a match of its own: the anchors were
 * resolved once for this redraw already.
 */
class WidgetPainter implements PluginValue {
	/** Whether any widget may carry our marks, so an empty note stays free. */
	private painted = false;

	constructor(private readonly view: EditorView) {
		this.schedule();
	}

	update(update: ViewUpdate): void {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.startState.field(threadSpansField) !== update.state.field(threadSpansField)
		)
			this.schedule();
	}

	/** After CodeMirror has drawn: an update runs before the widget DOM is rebuilt. */
	private schedule(): void {
		const spans = this.view.state.field(threadSpansField);
		if (spans.length === 0 && !this.painted) return;
		this.view.requestMeasure({ key: this, read: () => null, write: () => this.paint() });
	}

	private paint(): void {
		const { view } = this;
		const spans = view.state.field(threadSpansField);
		const doc = view.state.doc;
		let painted = false;

		for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(WIDGETS))) {
			// A callout holding a table: the outer widget paints both.
			if (el.parentElement?.closest(WIDGETS)) continue;
			let block;
			try {
				block = view.lineBlockAt(view.posAtDOM(el));
			} catch {
				continue;
			}

			const highlights: ReadingHighlight[] = spans
				.filter((span) => span.from >= block.from && span.from <= block.to)
				.map((span) => {
					const text = span.line ? "" : doc.sliceString(span.from, span.to);
					return {
						id: span.id,
						text,
						occurrence:
							text === ""
								? 0
								: appearances(doc.sliceString(block.from, span.from), text),
					};
				});

			const signature = JSON.stringify(highlights);
			const marks = el.querySelectorAll(`.${READING_MARK_CLASS}`).length;
			// Same threads and the marks still there: the widget was not re-rendered.
			if (el.dataset[PAINTED] === `${marks}:${signature}`) {
				painted ||= highlights.length > 0;
				continue;
			}

			clearReadingMarks(el);
			unmarkBlock(el);
			const unplaced = highlights
				.filter(
					(highlight) =>
						highlight.text === "" || paintReadingMarks(el, [highlight]) === 0,
				)
				.map((highlight) => highlight.id);
			if (unplaced.length > 0) markBlock(el, unplaced);

			const placed = el.querySelectorAll(`.${READING_MARK_CLASS}`).length;
			el.dataset[PAINTED] = `${placed}:${signature}`;
			painted ||= highlights.length > 0;
		}
		this.painted = painted;
	}
}

export function widgetHighlights(): Extension {
	return ViewPlugin.fromClass(WidgetPainter);
}
