import { Notice, TFile, type TAbstractFile } from "obsidian";
import type { CommentStorage } from "./storage";
import type { OrphanedBehavior } from "./types";
import { movesFor } from "./note-moves";
import { DeletedNotes, describeNoteDeletion, describeNoteRestore } from "./deleted-notes";

/** What keeping comments with their notes needs from the plugin. */
export interface NoteEventsHost {
	storage: CommentStorage;
	orphanedBehavior(): OrphanedBehavior;
	refresh(): Promise<void>;
}

/** Keeps comments with their note through renames, moves, deletes and restores. */
export class NoteEvents {
	/** Comments waiting for their note to come back. See DeletedNotes. */
	private deleted = new DeletedNotes();

	constructor(private host: NoteEventsHost) {}

	/**
	 * Move comments to wherever their note went.
	 *
	 * A folder rename arrives as several overlapping events — the folder, then
	 * every descendant — so the same note is handled more than once. That is safe
	 * because `moveComments` holds both notes' queues: a second move of the same
	 * note waits for the first and finds nothing left to move, so nothing here
	 * needs to sequence the events itself.
	 *
	 * Renaming a note that carries no comments moves nothing and costs one index
	 * read.
	 */
	async followRename(from: string, to: string): Promise<void> {
		const summaries = await this.host.storage.getCommentSummaries();
		const moves = movesFor(
			summaries.map((summary) => summary.filePath),
			from,
			to,
		);
		if (moves.length === 0) return;

		for (const move of moves) await this.host.storage.moveComments(move.from, move.to);
		await this.host.refresh();
	}

	/**
	 * Take a note's comments with it when it is deleted, recoverably.
	 *
	 * Only the file events matter: a folder carries no comments of its own, and
	 * Obsidian was measured emitting a delete for every note underneath it. If
	 * that ever stopped, the comments would stay behind and show as a "not found"
	 * note in the all-notes view — visible, not lost — which is why this needs no
	 * folder cascade where the rename handler does.
	 */
	async followDelete(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		if (this.host.orphanedBehavior() === "keep") {
			await this.host.refresh();
			return;
		}

		const comments = await this.host.storage.takeComments(file.path);
		if (comments.length === 0) return;

		this.deleted.remember(file.path, comments);
		new Notice(describeNoteDeletion(file.path, comments.length));
		await this.host.refresh();
	}

	/**
	 * Give a note back its comments when it reappears.
	 *
	 * Restoring from the trash is routine, and some sync setups present a rename
	 * as delete-then-create; both arrive here. Obsidian also fires create for
	 * every file while it indexes a vault at startup, which is harmless: nothing
	 * is held yet, so every one of those is a map lookup that misses.
	 */
	async followCreate(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") return;

		const comments = this.deleted.recover(file.path);
		if (comments === null) return;

		await this.host.storage.restoreComments(file.path, comments);
		new Notice(describeNoteRestore(file.path, comments.length));
		await this.host.refresh();
	}
}
