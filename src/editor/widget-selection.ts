import { appearances, locateAcrossSegments } from "../reading/reading-highlights";

/**
 * Map words selected in a rendered block back to a range of its source.
 *
 * Live preview draws a callout as a widget CodeMirror cannot select into, so the
 * words live only in the window's selection (#421). `before` is the rendered text
 * ahead of the selection inside the widget, which says which appearance of the
 * words was picked, the way reading mode counts them.
 *
 * Returns offsets into `source`, or null when the words cannot be found exactly
 * once over: Markdown the renderer consumed (`**bold** word` shows `bold word`)
 * or a different number of appearances in the two texts would make any answer a guess.
 */
export function widgetSelection(
	source: string,
	rendered: string,
	before: string,
	selected: string,
): { from: number; to: number } | null {
	if (appearances(rendered, selected) !== appearances(source, selected)) return null;
	const slices = locateAcrossSegments([source], selected, appearances(before, selected));
	if (!slices || slices.length === 0) return null;
	return { from: slices[0].start, to: slices[slices.length - 1].end };
}
