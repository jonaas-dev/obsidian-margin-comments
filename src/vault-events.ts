import { Notice, TFile, type TAbstractFile } from "obsidian";
import type { CommentStorage } from "./storage";
import type { Comment, OrphanedBehavior } from "./types";
import { matchAnchor } from "./anchor";
import {
	describeStorageDeleted,
	describeStorageFollowed,
	describeStorageUnreachable,
	describeStrandedComments,
	inStorageFolder,
	movesFor,
} from "./note-moves";
import { toStorageFolder } from "./settings-values";
import { describeNoteDeletion, describeNoteMove, describeNoteRestore } from "./deleted-notes";

/** What keeping comments with their notes needs from the plugin. */
interface NoteEventsHost {
	storage: CommentStorage;
	orphanedBehavior(): OrphanedBehavior;
	refresh(): Promise<void>;
	/** A note's text, or null when it cannot be read. Used to recognise a moved note. */
	readNote(filePath: string): Promise<string | null>;
	/** The reader's fuzzy tolerance, so recognising a note matches what anchoring does. */
	fuzzyThreshold(): number;
	/** The storage folder now, which the Vault API sees when it is not a dotfolder. */
	storageDir(): string;
	/** The user renamed the storage folder to `to` (D4). */
	onStorageFolderRenamed(to: string): Promise<void>;
	/** The user deleted the storage folder (D5). */
	onStorageFolderDeleted(): Promise<void>;
}

/**
 * Point `storage` at the folder the user renamed it to, if it can live there.
 *
 * moveTo rather than a bare switch: it waits for queued writes and drops the caches
 * and the index the old path keyed, and with the source already gone it copies
 * nothing. `persist` gets `storage.dir`, which is what the store writes to from now
 * on, even if moveTo rejected after switching. A name the setting would refuse (D1:
 * one folder at the vault root) keeps the old setting and forgets the caches, so
 * nothing on screen is edited back into a folder that is no longer there.
 */
export async function followStorageRename(
	storage: CommentStorage,
	to: string,
	configDir: string,
	persist: (dir: string) => Promise<void>,
): Promise<void> {
	const from = storage.dir;
	const name = toStorageFolder(to, "", configDir);
	if (name !== "") {
		await storage.moveTo(name).catch((error: unknown) => {
			console.error("margin-comments: could not follow the renamed storage folder", error);
		});
	}
	if (name !== "" && storage.dir === name) {
		await persist(name);
		new Notice(describeStorageFollowed(name));
		return;
	}
	storage.forget();
	// No timeout: until the folder is renamed back, every comment in it is out of reach.
	new Notice(describeStorageUnreachable(to, from), 0);
}

/**
 * Forget the deleted storage folder without recreating it (D5).
 *
 * Nothing is written here: the folder comes back with the next comment saved, so a
 * user restoring it from the trash first does not find a fresh one in the way.
 */
export function forgetDeletedStorage(storage: CommentStorage): void {
	storage.forget();
	new Notice(describeStorageDeleted(storage.dir), 0);
}

/**
 * How long a create and a delete may be apart and still be considered a pair.
 *
 * A pre-filter and nothing more. #289 measured a real external rename at 103 ms
 * between its create and its delete, and an unrelated save-and-delete at 109 ms:
 * timing cannot tell them apart, so this only keeps the candidate list short.
 * What decides is whether the comments fit the new note.
 */
const PAIR_WINDOW_MS = 3000;

/** Keeps comments with their note through renames, moves, deletes and restores. */
export class NoteEvents {
	/** Markdown notes created recently, by path, for pairing with a delete (#289). */
	private readonly recentCreates = new Map<string, number>();

	constructor(private readonly host: NoteEventsHost) {}

	/**
	 * Whether `comments` belong to the note now at `filePath`.
	 *
	 * Every one of them has to find its place in the text, using the same
	 * matcher that decides whether a comment is orphaned — so this brings no
	 * second notion of "the same note" to disagree with the first. All of them
	 * rather than most: a note renamed outside Obsidian is unchanged, so its
	 * comments all fit, and anything less lets an unrelated file that happens to
	 * share a sentence take them (#289).
	 *
	 * An empty list never recognises anything: nothing fitting nowhere is not a
	 * match, it is an absence of evidence.
	 */
	private async recognises(filePath: string, comments: Comment[]): Promise<boolean> {
		if (comments.length === 0) return false;
		const doc = await this.host.readNote(filePath);
		if (doc === null) return false;
		const threshold = this.host.fuzzyThreshold();
		return comments.every(
			(comment) => matchAnchor(doc, comment.anchor, { fuzzy: true, threshold }) !== null,
		);
	}

	/** Paths created within the pairing window, newest first, pruned as it goes. */
	private candidates(now: number): string[] {
		for (const [path, at] of this.recentCreates) {
			if (now - at > PAIR_WINDOW_MS) this.recentCreates.delete(path);
		}
		return [...this.recentCreates.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
	}

	/**
	 * Hand a held note's comments to the note it was moved to, if exactly one
	 * candidate recognises them.
	 *
	 * Exactly one: with two files that both fit, there is no way to tell which
	 * is the move, and leaving the comments held is recoverable where guessing
	 * is not.
	 */
	private async reattach(from: string, comments: Comment[], to: string[]): Promise<boolean> {
		const fits: string[] = [];
		for (const candidate of to) {
			if (candidate === from) continue;
			if (await this.recognises(candidate, comments)) fits.push(candidate);
		}
		if (fits.length !== 1) return false;

		const target = fits[0];
		const taken = await this.host.storage.releaseComments(from);
		if (taken === null) return false;
		await this.host.storage.restoreComments(
			target,
			taken.map((comment) => ({ ...comment, filePath: target })),
		);
		new Notice(describeNoteMove(from, target, taken.length));
		return true;
	}

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
		const dir = this.host.storageDir();
		if (from === dir) {
			await this.host.onStorageFolderRenamed(to);
			await this.host.refresh();
			return;
		}
		// The store's own writes land here with a visible folder: every save renames
		// a .tmp into place, and treating it as a note read the index each time.
		if (inStorageFolder(from, dir) || inStorageFolder(to, dir)) return;

		const summaries = await this.host.storage.getCommentSummaries();
		const moves = movesFor(
			summaries.map((summary) => summary.filePath),
			from,
			to,
		);
		if (moves.length === 0) return;

		// Each note on its own: one that cannot be moved — read-only, or a sidecar a
		// newer plugin wrote — used to reject the whole handler on the first failure,
		// so the notes after it kept their old paths and nothing said why (#266). The
		// per-file events that follow a folder rename cover for it today, which is
		// exactly what made the loss invisible.
		const stranded: string[] = [];
		for (const move of moves) {
			try {
				await this.host.storage.moveComments(move.from, move.to);
			} catch (error) {
				stranded.push(move.from);
				console.error("margin-comments: comments could not follow their note", error);
			}
		}
		await this.host.refresh();
		if (stranded.length > 0) new Notice(describeStrandedComments(stranded));
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
		const dir = this.host.storageDir();
		if (file.path === dir) {
			await this.host.onStorageFolderDeleted();
			await this.host.refresh();
			return;
		}
		if (inStorageFolder(file.path, dir)) return;
		if (!(file instanceof TFile) || file.extension !== "md") return;
		if (this.host.orphanedBehavior() === "keep") {
			await this.host.refresh();
			return;
		}

		// Held on disk, not taken off it. A note renamed outside Obsidian arrives
		// here as a delete and never comes back at the path it left, so comments
		// held only for the session were gone when Obsidian closed (#259).
		const comments = await this.host.storage.holdComments(file.path);
		if (comments.length === 0) return;

		// A note moved outside Obsidian arrives as a create for the new path and
		// then this delete, never a rename (#259). If one of the notes created
		// just now recognises these comments, this was a move (#289).
		if (await this.reattach(file.path, comments, this.candidates(Date.now()))) {
			await this.host.refresh();
			return;
		}

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
		if (inStorageFolder(file.path, this.host.storageDir())) return;

		this.recentCreates.set(file.path, Date.now());

		const comments = await this.host.storage.releaseComments(file.path);
		if (comments === null) return;

		await this.host.storage.restoreComments(file.path, comments);
		new Notice(describeNoteRestore(file.path, comments.length));
		await this.host.refresh();
	}
}
