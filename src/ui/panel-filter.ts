import type { Thread } from "../threads";
import { THREAD_FILTERS, type ThreadFilter } from "../types";

export type { ThreadFilter };


/**
 * Narrow the panel to one bucket.
 *
 * The decision is taken on the thread root: replies have no resolved state of
 * their own, so a thread is shown or hidden whole. Order is left untouched —
 * sorting is decided before filtering, not here.
 */
export function filterThreads(threads: Thread[], filter: ThreadFilter): Thread[] {
	if (filter === "all") return threads;
	const wantResolved = filter === "resolved";
	return threads.filter((thread) => thread.root.resolved === wantResolved);
}

/** Size of every bucket, so the segments can be labelled without re-filtering. */
export function countThreads(threads: Thread[]): Record<ThreadFilter, number> {
	const resolved = threads.filter((thread) => thread.root.resolved).length;
	return { all: threads.length, open: threads.length - resolved, resolved };
}

export function filterLabel(filter: ThreadFilter): string {
	switch (filter) {
		case "all":
			return "All";
		case "open":
			return "Open";
		case "resolved":
			return "Resolved";
	}
}

/**
 * What an empty list means depends on the filter; one generic line would lie.
 *
 * On touch the first step is a tap: there is no hover to describe, and the
 * marker shows on the caret's line (#126).
 */
export function emptyStateMessage(filter: ThreadFilter, touch = false): string {
	switch (filter) {
		case "all":
			return touch
				? "Tap a line, then the comment icon beside it, to add the first comment."
				: "Hover the left edge of a line to add the first comment.";
		case "open":
			return "No open comments. Everything on this note is resolved.";
		case "resolved":
			return "No resolved comments yet.";
	}
}

/** Read back a persisted filter, tolerating anything that is not one. */
export function toThreadFilter(value: unknown): ThreadFilter {
	return THREAD_FILTERS.includes(value as ThreadFilter) ? (value as ThreadFilter) : "all";
}
