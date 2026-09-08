import { locateAcrossSegments, type ReadingHighlight } from "./reading-highlights";

export const READING_MARK_CLASS = "inline-comment-reading-mark";
export const READING_BLOCK_CLASS = "inline-comment-reading-block";

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
		);
		if (slices === null) continue;

		for (const slice of slices) {
			const node = nodes[slice.index];
			const target = slice.start > 0 ? node.splitText(slice.start) : node;
			const length = slice.end - slice.start;
			if (length < target.data.length) target.splitText(length);

			const mark = document.createElement("span");
			mark.className = READING_MARK_CLASS;
			mark.dataset.threadId = highlight.id;
			target.replaceWith(mark);
			mark.appendChild(target);
		}
		placed++;
	}

	return placed;
}

function textNodesIn(root: HTMLElement): Text[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		nodes.push(node as Text);
	}
	return nodes;
}
