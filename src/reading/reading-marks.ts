import { locateAcrossSegments, type ReadingHighlight } from "./reading-highlights";

export const READING_MARK_CLASS = "inline-comment-reading-mark";
export const READING_BLOCK_CLASS = "inline-comment-reading-block";

/** Mark a whole block, recording the threads it stands for so a tap can open them. */
export function markBlock(el: HTMLElement, threadIds: string[]): void {
	el.classList.add(READING_BLOCK_CLASS);
	el.dataset.threadIds = threadIds.join(" ");
}

/** Undo markBlock: a re-render can hand back a block whose thread is now resolved. */
export function unmarkBlock(el: HTMLElement): void {
	el.classList.remove(READING_BLOCK_CLASS);
	delete el.dataset.threadIds;
}

/**
 * Undo paintReadingMarks, leaving the text nodes as they were.
 *
 * Live preview keeps a rendered table or callout across edits, so it is
 * repainted in place (#419) and must not collect a second layer of marks.
 */
export function clearReadingMarks(el: HTMLElement): void {
	// Only the marks' parents are normalised: the whole block may hold a cell's
	// nested editor, whose text nodes are CodeMirror's to manage.
	const parents = new Set<Node>();
	for (const mark of Array.from(el.querySelectorAll(`.${READING_MARK_CLASS}`))) {
		if (mark.parentNode) parents.add(mark.parentNode);
		mark.replaceWith(...Array.from(mark.childNodes));
	}
	for (const parent of parents) parent.normalize();
}

/**
 * Mark the commented stretches of a rendered block.
 *
 * Returns how many highlights were placed, which is how the caller learns that
 * a comment could not be found in the rendered text and the block itself should
 * carry the mark instead.
 */
export function paintReadingMarks(el: HTMLElement, highlights: ReadingHighlight[]): number {
	let placed = 0;

	for (const highlight of highlights) {
		// Re-collected per highlight: wrapping splits text nodes, so a list
		// gathered once would hold nodes that are no longer the whole story.
		const nodes = textNodesIn(el);
		const slices = locateAcrossSegments(
			nodes.map((node) => node.data),
			highlight.text,
			highlight.occurrence,
		);
		if (slices === null) continue;

		for (const slice of slices) {
			const node = nodes[slice.index];
			const target = slice.start > 0 ? node.splitText(slice.start) : node;
			const length = slice.end - slice.start;
			if (length < target.data.length) target.splitText(length);

			const mark = createSpan();
			mark.className = READING_MARK_CLASS;
			mark.dataset.threadId = highlight.id;
			target.replaceWith(mark);
			mark.appendChild(target);
		}
		placed++;
	}

	return placed;
}

/**
 * The threads a tap on `target` lands on, innermost first.
 *
 * Marks nest when two comments cover the same words, so every mark up the chain
 * counts, and so does a block that carries the rule in place of marks.
 */
export function threadIdsAt(target: Element): string[] {
	const ids: string[] = [];
	for (let el: Element | null = target; el !== null; el = el.parentElement) {
		// Obsidian's cross-window check, not `instanceof`. Measured in a popout on
		// 2026-10-07: the mark is an instance of the *main* window's HTMLElement and
		// not of its own window's, so a bare `instanceof` happens to work here only
		// because this code created the element from the main document. `.instanceOf`
		// returned true for the same element and does not depend on that (#336).
		if (!el.instanceOf(HTMLElement)) continue;
		if (el.classList.contains(READING_MARK_CLASS) && el.dataset.threadId)
			ids.push(el.dataset.threadId);
		if (el.classList.contains(READING_BLOCK_CLASS) && el.dataset.threadIds) {
			ids.push(...el.dataset.threadIds.split(" "));
		}
	}
	return [...new Set(ids)];
}

function textNodesIn(root: HTMLElement): Text[] {
	// Not into an editor nested in the block: live preview edits a table cell in
	// a CodeMirror of its own, and splitting its text would corrupt it (#419).
	// Reading mode's blocks hold no editor, so there both sides are null.
	const editor = root.closest(".cm-editor");
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		if (node.parentElement?.closest(".cm-editor") === editor) nodes.push(node as Text);
	}
	return nodes;
}
