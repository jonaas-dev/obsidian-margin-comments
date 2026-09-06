import type { Comment } from "./types";
import { noteName } from "./utils";

/**
 * Comments belonging to notes deleted this session.
 *
 * Deleting a note takes its comments with it, which is what was asked for — but
 * Obsidian sends deleted notes to the trash and restoring one is routine, and
 * some sync setups present a rename as delete-then-create. Both would lose
 * comments silently, so the comments are held here and put back the moment a
 * note reappears at the same path.
 *
 * In memory, and gone when Obsidian closes. Persisting it would be a second
 * store to keep in step with the sidecars, and a deleted note that has not come
 * back within a session is deleted.
 */
export class DeletedNotes {
	private byPath = new Map<string, Comment[]>();

	remember(filePath: string, comments: Comment[]): void {
		if (comments.length === 0) return;
		// Merged rather than replaced: deleting a note twice in one session means
		// it came back in between, and the second delete carries the newer set.
		const held = this.byPath.get(filePath) ?? [];
		const known = new Set(held.map((comment) => comment.id));
		this.byPath.set(filePath, [...held, ...comments.filter((c) => !known.has(c.id))]);
	}

	/** Hand back what was held for this path, and stop holding it. */
	recover(filePath: string): Comment[] | null {
		const held = this.byPath.get(filePath);
		if (held === undefined) return null;
		this.byPath.delete(filePath);
		return held;
	}

	/** Notes still held, for tests and for reasoning about what a restore covers. */
	get size(): number {
		return this.byPath.size;
	}
}

function plural(count: number): string {
	return count === 1 ? "comment" : "comments";
}

/** Said when a note is deleted, so its comments do not vanish unannounced. */
export function describeNoteDeletion(filePath: string, count: number): string {
	return `${count} ${plural(count)} removed with ${noteName(filePath)}. Restoring the note brings them back until Obsidian closes.`;
}

/** Said when they come back, so the recovery is visible rather than assumed. */
export function describeNoteRestore(filePath: string, count: number): string {
	return `${count} ${plural(count)} restored with ${noteName(filePath)}.`;
}
