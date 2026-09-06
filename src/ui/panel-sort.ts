import type { SortOrder } from "../types";
import type { Thread } from "./threads";

export const SORT_ORDERS: readonly SortOrder[] = ["position", "date", "lastActivity"];

/** Most recent timestamp anywhere in the thread, replies included. */
export function lastActivity(thread: Thread): number {
	return thread.replies.reduce((latest, reply) => Math.max(latest, reply.updatedAt), thread.root.updatedAt);
}

/**
 * Rank within a mode. Higher sorts first, so the two time modes read newest
 * first: a panel that opens on the oldest thread buries what just happened.
 */
function rank(thread: Thread, order: SortOrder): number {
	switch (order) {
		case "position":
			// Negated so the shared comparator can stay "higher first": document
			// order runs the other way from the time modes.
			return -(thread.position ?? 0);
		case "date":
			return thread.root.createdAt;
		case "lastActivity":
			return lastActivity(thread);
	}
}

/**
 * Order the panel, orphans last.
 *
 * A lost anchor has no position to sort by, and in the time modes it would
 * often float to the top — a thread nobody can place is the last thing the
 * reader needs first. Ties keep the incoming order: Array#sort is stable, and
 * the comparator returns 0 rather than inventing a tiebreak.
 */
export function sortThreads(threads: Thread[], order: SortOrder): Thread[] {
	return [...threads].sort((a, b) => {
		if (a.position === null || b.position === null) {
			if (a.position === b.position) return 0;
			return a.position === null ? 1 : -1;
		}
		return rank(b, order) - rank(a, order);
	});
}

export function sortLabel(order: SortOrder): string {
	switch (order) {
		case "position":
			return "Document order";
		case "date":
			return "Date created";
		case "lastActivity":
			return "Last activity";
	}
}

/** Read back a persisted order, tolerating anything that is not one. */
export function toSortOrder(value: unknown): SortOrder {
	return SORT_ORDERS.includes(value as SortOrder) ? (value as SortOrder) : "position";
}
