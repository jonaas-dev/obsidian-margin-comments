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
	return { ...comment, content, updatedAt: now, editedAt: now };
}

/** Whether the body has been rewritten since it was written. */
export function wasEdited(comment: Comment): boolean {
	return comment.editedAt !== undefined;
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

/**
 * What a delete is about to destroy, phrased for a confirmation dialog.
 *
 * Deleting a thread root takes its replies with it — a reply whose root is gone
 * can never be displayed or re-anchored. Naming the count is the point: that
 * cascade is the surprise the dialog exists to prevent.
 */
export function describeDeletion(target: Comment, all: Comment[]): string {
	if (target.parentId !== null) return "Delete this reply?";

	const replies = all.filter((c) => c.parentId === target.id).length;
	if (replies === 0) return "Delete this comment?";
	return `Delete this comment and its ${replies} ${replies === 1 ? "reply" : "replies"}?`;
}
