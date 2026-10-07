import { lineNumberAt, matchAnchor, type MatchOptions } from "./anchor";
import type { Comment } from "./types";

export interface Thread {
	root: Comment;
	replies: Comment[];
	/** 1-based line the root is anchored to, or null when the anchor is lost. */
	line: number | null;
	/** Offset of the anchor, used for ordering. */
	position: number | null;
	/** Offset just past the anchor, so callers can read the matched text back. */
	end: number | null;
	orphaned: boolean;
}

/**
 * Group flat comment records into threads, resolved against the document.
 *
 * Replies are attached to their root rather than nested recursively — the model
 * is deliberately one level deep.
 *
 * `matching` decides how hard to look for a moved anchor. The panel asks for the
 * fuzzy stage; callers that run on every keystroke do not.
 */
export function buildThreads(
	doc: string,
	comments: Comment[],
	matching: MatchOptions = {},
): Thread[] {
	const byId = new Map(comments.map((c) => [c.id, c]));
	const repliesByRoot = new Map<string, Comment[]>();
	const roots: Comment[] = [];

	for (const comment of comments) {
		// A root can go missing through a partial sync. Promoting the orphaned
		// reply keeps content the user wrote visible; dropping it destroys it.
		if (comment.parentId === null || !byId.has(comment.parentId)) {
			roots.push(comment);
			continue;
		}
		const siblings = repliesByRoot.get(comment.parentId) ?? [];
		siblings.push(comment);
		repliesByRoot.set(comment.parentId, siblings);
	}

	const threads = roots.map((root): Thread => {
		const match = matchAnchor(doc, root.anchor, matching);
		return {
			root,
			replies: (repliesByRoot.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt),
			line: match ? lineNumberAt(doc, match.from) : null,
			position: match ? match.from : null,
			end: match ? match.to : null,
			orphaned: match === null,
		};
	});

	// Document order, with lost anchors last: they have no position to sort by,
	// and burying them mid-list would make them look misplaced rather than lost.
	return threads.sort((a, b) => {
		if (a.position === null) return b.position === null ? 0 : 1;
		if (b.position === null) return -1;
		return a.position - b.position;
	});
}
