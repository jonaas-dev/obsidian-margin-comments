import type { Comment } from "../types";

/**
 * The thread root a comment belongs to.
 *
 * Replying to a reply still hangs off the root: the model is deliberately flat,
 * and a parentId pointing at a reply would create a second level that nothing
 * renders and buildThreads would not group.
 */
export function rootIdFor(comment: Comment): string {
	return comment.parentId ?? comment.id;
}

/**
 * Build a reply to `target`, which may itself be a reply.
 *
 * The anchor is inherited rather than recomputed: a reply has no text of its own
 * to anchor to, and re-anchoring would let it drift away from the comment it
 * answers.
 */
export function createReply(
	target: Comment,
	content: string,
	author: string,
	now: number = Date.now(),
): Comment {
	return {
		id: crypto.randomUUID(),
		filePath: target.filePath,
		anchor: target.anchor,
		content,
		author,
		createdAt: now,
		updatedAt: now,
		// resolved is only meaningful on a root; resolving the root resolves the
		// thread, so a reply carrying its own state would be ignored at best.
		resolved: false,
		parentId: rootIdFor(target),
	};
}
