import { noteName } from "../utils";
import type { Thread } from "./threads";

/** Threads whose anchor no stage could place in the note. */
export function orphanCount(threads: Thread[]): number {
	return threads.filter((thread) => thread.orphaned).length;
}

/**
 * Why an orphaned card cannot be clicked, and where its text used to be.
 *
 * The note is named even in the note-scoped panel: a card only reaches the
 * reader with a path attached in the vault view, and the two views share this
 * renderer. Repeating the name costs a few words; a card that says "not found"
 * without saying where is a puzzle.
 *
 * The line is the one the anchor was created on, not the last place the comment
 * was seen — nothing updates `lineHint` after a successful re-anchor — so it is
 * described as such rather than implying the comment was there a moment ago.
 */
export function orphanExplanation(thread: Thread, filePath: string): string {
	return `Anchored text not found in ${noteName(filePath)}. It was on line ${thread.root.anchor.lineHint} when the comment was written; restoring the text re-anchors the comment.`;
}

/**
 * One notice a session, however many comments lose their anchor.
 *
 * A notice per orphan buries the screen the moment a paragraph is rewritten,
 * and a notice per note repeats the same news on every switch — the panel is
 * already showing which comments are affected, so this only has to say that
 * something happened at all.
 *
 * State lives on the plugin rather than the view: the panel is rebuilt whenever
 * it is closed and reopened, and a counter that resets with it would announce
 * the same orphans again.
 */
export class OrphanNotice {
	private announced = false;

	/** Whether the one announcement has been made, so callers can skip the work
	 *  of looking for orphans they can no longer report. */
	get spent(): boolean {
		return this.announced;
	}

	/**
	 * The message to show, or null when there is nothing new to say.
	 *
	 * The pointer to the panel only when the panel is not already on screen:
	 * telling a reader to open what they are looking at reads as the plugin not
	 * knowing its own state (#143).
	 */
	take(count: number, panelVisible = false): string | null {
		if (this.announced || count === 0) return null;
		this.announced = true;
		const plural = count === 1 ? "comment" : "comments";
		const possessive = count === 1 ? "its" : "their";
		const lost = `${count} ${plural} lost ${possessive} anchor.`;
		return panelVisible ? lost : `${lost} Open the comments panel to see which.`;
	}
}
