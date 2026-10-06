import { noteName } from "./utils";

function plural(count: number): string {
	return count === 1 ? "comment" : "comments";
}

/**
 * Said when a note is deleted, so its comments do not vanish unannounced.
 *
 * No longer promises only "until Obsidian closes": they are held on disk now, so
 * the promise outlives the session (#259).
 */
export function describeNoteDeletion(filePath: string, count: number): string {
	return `${count} ${plural(count)} removed with ${noteName(filePath)}. They are kept, and come back if the note does.`;
}

/** Said when they come back, so the recovery is visible rather than assumed. */
export function describeNoteRestore(filePath: string, count: number): string {
	return `${count} ${plural(count)} restored with ${noteName(filePath)}.`;
}
