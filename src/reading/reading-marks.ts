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

/**
 * The threads a tap on `target` lands on, innermost first.
 *
 * Marks nest when two comments cover the same words, so every mark up the chain
 * counts, and so does a block that carries the rule in place of marks.
 */
export function threadIdsAt(target: Element): string[] {
	const ids: string[] = [];
	for (let el: Element | null = target; el !== null; el = el.parentElement) {
		if (!(el instanceof HTMLElement)) continue;
		if (el.classList.contains(READING_MARK_CLASS) && el.dataset.threadId) ids.push(el.dataset.threadId);
		if (el.classList.contains(READING_BLOCK_CLASS) && el.dataset.threadIds) {
			ids.push(...el.dataset.threadIds.split(" "));
		}
	}
	return [...new Set(ids)];
}

function textNodesIn(root: HTMLElement): Text[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		nodes.push(node as Text);
	}
	return nodes;
}
