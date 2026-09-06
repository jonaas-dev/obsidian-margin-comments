import type { Comment } from "../types";

/**
 * A copy with a new body.
 *
 * createdAt is deliberately untouched: the panel shows an "edited" marker by
 * comparing it against updatedAt, so moving it would erase the evidence. The
 * anchor is left alone too — editing the comment says nothing about the text it
 * points at.
 */
export function withEditedContent(comment: Comment, content: string, now = Date.now()): Comment {
	return { ...comment, content, updatedAt: now };
}

/**
 * A copy with a new resolved state.
 *
 * Only meaningful on a thread root: resolving a root resolves its thread.
 * updatedAt moves so last-activity sorting notices the change.
 */
export function withResolved(comment: Comment, resolved: boolean, now = Date.now()): Comment {
	return { ...comment, resolved, updatedAt: now };
}
