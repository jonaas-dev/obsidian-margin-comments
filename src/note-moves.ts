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
