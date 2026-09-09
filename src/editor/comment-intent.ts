/** A half-open span of the document, `to` exclusive. */
export interface Span {
	from: number;
	to: number;
}

/** A thread as this decision needs it: where it sits, and which one it is. */
export interface AnchoredThread extends Span {
	id: string;
}

/** What a click on the gutter, or the add-comment command, should do. */
export type CommentIntent =
	| { kind: "compose"; from: number; to: number }
	| { kind: "show"; threadId: string };

/**
 * Whether a thread's anchor covers any of a line.
 *
 * `to` is exclusive, so a thread ending exactly where the line starts ends on
 * the line before and does not count. A zero-length anchor is a position rather
 * than a span, so it counts when it sits anywhere in the line, its end included.
 */
function coversLine(thread: Span, line: Span): boolean {
	if (thread.from === thread.to) return thread.from >= line.from && thread.from <= line.to;
	return thread.from <= line.to && thread.to > line.from;
}

/** Whether two spans share a position. Touching end to end is not sharing. */
function overlaps(a: Span, b: Span): boolean {
	return a.from < b.to && b.from < a.to;
}

/**
 * Decide between showing the thread that is already here and starting a new one.
 *
 * Reading is the more common intent, so a bare click on a commented line shows
 * what is there. But a *selection* is not a bare click: it names the words the
 * comment is about, and the command that carries one is called "Add comment to
 * selection". So the rule is about what the selection says:
 *
 * - a selection over text that already carries a thread asks for that thread
 * - a selection over anything else asks for a new one, commented line or not (#75)
 * - no usable selection shows what is there, or comments the whole line
 *
 * "Usable" is doing real work: a selection somewhere else in the note has
 * nothing to do with the line being acted on, and using it anyway anchored the
 * comment to text the reader was not pointing at (#81).
 */
export function commentIntent(
	threads: readonly AnchoredThread[],
	line: Span,
	selection: Span,
): CommentIntent {
	const onLine = threads.filter((thread) => coversLine(thread, line));
	// Document order, not the order the comments happen to be stored in: when
	// several answer, the one nearest the top of the note is the least
	// surprising, and storage order is creation order.
	const inOrder = [...onLine].sort((a, b) => a.from - b.from);

	const usable =
		selection.from !== selection.to && overlaps(selection, line) ? selection : null;

	if (usable) {
		const covering = inOrder.find((thread) => overlaps(thread, usable));
		if (covering) return { kind: "show", threadId: covering.id };
		return { kind: "compose", from: usable.from, to: usable.to };
	}

	if (inOrder.length > 0) return { kind: "show", threadId: inOrder[0].id };
	// from === to is how a whole-line comment is asked for: createAnchor widens
	// it to the line and marks it as one.
	return { kind: "compose", from: line.from, to: line.from };
}
