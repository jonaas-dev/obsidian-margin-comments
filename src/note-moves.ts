/** A note's comments changing address. */
export interface Move {
	from: string;
	to: string;
}

/**
 * Where `path` ends up when `from` is renamed to `to`, or null if it is untouched.
 *
 * The prefix case covers a folder rename. Obsidian was measured emitting one
 * event for the folder and one for every descendant, folders included and
 * outermost first, so the per-file events alone would do the job today — but
 * that ordering is undocumented, and a folder whose notes stayed behind fails
 * silently. Handling the folder event is what makes the outcome not depend on it.
 *
 * The trailing slash is what stops a rename of `notes` from also claiming
 * `notes-archive`: prefix matching on the bare name is the classic way to move
 * files nobody touched.
 */
export function movedPath(path: string, from: string, to: string): string | null {
	if (path === from) return to;

	const prefix = `${from}/`;
	return path.startsWith(prefix) ? `${to}/${path.slice(prefix.length)}` : null;
}

/**
 * Every commented note a rename moves, old path and new.
 *
 * Driven by the notes the store already knows about rather than by the vault:
 * only commented notes have anything to move, and the index lists exactly those.
 */
export function movesFor(paths: string[], from: string, to: string): Move[] {
	const moves: Move[] = [];
	for (const path of paths) {
		const moved = movedPath(path, from, to);
		// A no-op rename would otherwise queue a move onto itself, which deletes
		// the sidecar it just wrote.
		if (moved !== null && moved !== path) moves.push({ from: path, to: moved });
	}
	return moves;
}

/**
 * Which notes' comments stayed behind when their note moved.
 *
 * Named, because the comments are not lost — they sit under the old path and
 * show as a "not found" note in the all-notes view, which is unexplainable
 * without this (#266).
 */
export function describeStrandedComments(paths: string[]): string {
	const names = paths.map((path) => path.split("/").pop() ?? path);
	const which = names.length === 1 ? names[0] : `${names.length} notes`;
	return `Comments for ${which} could not follow the note and are still under the old path.`;
}

/** Whether `path` is the storage folder or anything under it. */
export function inStorageFolder(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}

/** Said when the user renamed the storage folder and the setting followed it. */
export function describeStorageFollowed(dir: string): string {
	return `Comments folder renamed to ${dir}; Margin Comments follows it.`;
}

/** Said when the storage folder went where the setting cannot follow (D1: one root folder). */
export function describeStorageUnreachable(to: string, dir: string): string {
	return `Comments folder moved to ${to}, which cannot hold comments. They are unreachable until it is renamed back to ${dir}.`;
}

/** Said when the user deleted the storage folder. */
export function describeStorageDeleted(dir: string): string {
	return `Comments folder ${dir} was deleted. Restore it from the trash to get its comments back; the next new comment creates it again.`;
}

/** Said when the user moved the comments to another folder, or when the move was refused. */
export function describeStorageMove(
	to: string,
	result: { moved: number; merged: number; keptBoth: number; leftInSource: string[] },
): string {
	const parts = [`Moved ${result.moved} comment file(s) to ${to}`];
	if (result.merged > 0) parts.push(`merged ${result.merged} with files already there`);
	let text = `${parts.join(", ")}.`;
	if (result.keptBoth > 0) {
		text += ` ${result.keptBoth} could not be merged and stay in the old folder too.`;
	}
	if (result.leftInSource.length > 0) {
		text += ` Left in the old folder: ${result.leftInSource.join(", ")}.`;
	}
	return text;
}
