import { matchByContext, matchByHash } from "../anchor";
import type { Comment } from "../types";

export interface Thread {
	root: Comment;
	replies: Comment[];
	/** 1-based line the root is anchored to, or null when the anchor is lost. */
	line: number | null;
	/** Offset of the anchor, used for ordering. */
	position: number | null;
	orphaned: boolean;
}

function lineNumberAt(doc: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < doc.length; i++) {
		if (doc[i] === "\n") line++;
	}
	return line;
}

/**
 * Group flat comment records into threads, resolved against the document.
 *
 * Replies are attached to their root rather than nested recursively — the model
 * is deliberately one level deep.
 */
export function buildThreads(doc: string, comments: Comment[]): Thread[] {
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
		const match = matchByHash(doc, root.anchor) ?? matchByContext(doc, root.anchor);
		return {
			root,
			replies: (repliesByRoot.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt),
			line: match ? lineNumberAt(doc, match.from) : null,
			position: match ? match.from : null,
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

function plural(value: number, unit: string): string {
	return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

/** Human-readable age, falling back to an absolute date once it stops helping. */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
	const elapsed = now - timestamp;
	if (elapsed < MINUTE) return "just now";
	if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute");
	if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
	if (elapsed < MONTH) return plural(Math.floor(elapsed / DAY), "day");
	return new Date(timestamp).toLocaleDateString();
}
