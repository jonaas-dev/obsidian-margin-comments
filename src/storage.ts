import { normalizePath } from "obsidian";
import type { Comment, TextAnchor } from "./types";
import { hashString, noteName } from "./utils";
import { mergeComments, StorageMoveError, type MoveResult } from "./storage-move";

export { StorageMoveError, type MoveResult, type MoveRefusal } from "./storage-move";

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

export const STORAGE_DIR = ".margin-comments";
export const INDEX_FILE = "_index.json";
/**
 * Where a deleted note's comments wait for it to come back.
 *
 * A subfolder on purpose: `isSidecar` only recognises a `.json` directly in
 * STORAGE_DIR, so nothing held here is reconciled into the index or read by the
 * ordinary path. Held on disk rather than in memory because a note renamed
 * outside Obsidian never comes back at the path it left, and comments held only
 * for the session were gone when Obsidian closed (#259).
 */
export const HELD_DIR = "held";

/**
 * The two names a set-aside sidecar is given, both stamped with the time. A move
 * appends `-<n>` when the target already holds a different file of that name.
 */
const SET_ASIDE = /\.(invalid|unreadable)-\d+(-\d+)*$/;

/**
 * The slice of Obsidian's DataAdapter this plugin uses.
 *
 * Everything goes through the adapter rather than the Vault API because
 * STORAGE_DIR is a dotfolder, and the Vault API skips those: vault.create,
 * vault.getAbstractFileByPath and the vault change events would all miss it.
 * A visible storage folder is still reached only through the adapter, so the
 * Vault API never sees a sidecar written there as a note.
 * Declaring the surface structurally also keeps the store testable.
 */
export interface StorageAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(path: string, newPath: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	rmdir(path: string, recursive: boolean): Promise<void>;
}

/**
 * Version of the on-disk format, written into every sidecar and into the index.
 *
 * A file a newer plugin wrote is read but never rewritten, so an older plugin cannot
 * downgrade it. A file with no version predates versions, and is migrated by being
 * rewritten on its next change.
 */
export const FORMAT_VERSION = 1;

/** One note's comments, as stored. */
interface Sidecar {
	version: number;
	/** Kept inside the file so the store can be rebuilt without the index. */
	filePath: string;
	comments: Comment[];
}

/** What the index remembers about one note, so the vault view needs no sidecar. */
interface IndexEntry {
	hash: string;
	/** Thread roots, not comments: the panel lists threads. */
	threads: number;
	/** Roots still unresolved, so the filter can count without reading. */
	open: number;
}

type Index = Record<string, IndexEntry>;

/** One note's line in the all-files view. */
export interface CommentSummary {
	filePath: string;
	threads: number;
	open: number;
}

function summarise(comments: Comment[]): { threads: number; open: number } {
	const roots = comments.filter((comment) => comment.parentId === null);
	return { threads: roots.length, open: roots.filter((root) => !root.resolved).length };
}

function isEntry(value: unknown): value is IndexEntry {
	const entry = value as IndexEntry | null;
	return typeof entry?.hash === "string" && typeof entry.threads === "number";
}

/** A sidecar as parsed, before anything inside it is trusted. */
interface RawSidecar {
	version?: unknown;
	filePath: unknown;
	comments: unknown[];
}

/**
 * The format version a parsed file declares: 0 when it predates versions, null when
 * the declared version is not a whole number, which no plugin ever wrote.
 */
function versionOf(value: { version?: unknown }): number | null {
	if (value.version === undefined) return 0;
	return Number.isInteger(value.version) && (value.version as number) >= 1
		? (value.version as number)
		: null;
}

/** The sidecar in `text`, or null when the text is not one. */
function parseSidecar(text: string): RawSidecar | null {
	try {
		const parsed = JSON.parse(text) as { comments?: unknown } | null;
		return Array.isArray(parsed?.comments) ? (parsed as RawSidecar) : null;
	} catch {
		return null;
	}
}

const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function isAnchor(value: unknown): value is TextAnchor {
	if (typeof value !== "object" || value === null) return false;
	const anchor = value as Partial<TextAnchor>;
	return (
		isText(anchor.selectedText) &&
		isText(anchor.textHash) &&
		typeof anchor.isLineComment === "boolean" &&
		isText(anchor.contextBefore) &&
		isText(anchor.contextAfter) &&
		isNumber(anchor.lineHint) &&
		isNumber(anchor.startOffset) &&
		isNumber(anchor.endOffset)
	);
}

/**
 * Whether `value` is a comment the plugin can use, stored under the note it claims.
 *
 * The rest of the plugin reads every field without checking, so one malformed comment
 * took down every thread in its note (#195). A comment naming another note is invalid
 * too: an edit would be written to that note's sidecar, where it does not exist.
 */
function isCommentOf(filePath: string, value: unknown): value is Comment {
	if (typeof value !== "object" || value === null) return false;
	const comment = value as Partial<Comment>;
	return (
		isText(comment.id) &&
		comment.id !== "" &&
		comment.filePath === filePath &&
		isAnchor(comment.anchor) &&
		isText(comment.content) &&
		isText(comment.author) &&
		isNumber(comment.createdAt) &&
		isNumber(comment.updatedAt) &&
		(comment.editedAt === undefined || isNumber(comment.editedAt)) &&
		typeof comment.resolved === "boolean" &&
		(comment.parentId === null || (isText(comment.parentId) && comment.parentId !== ""))
	);
}

interface StorageOptions {
	/** Folder holding the sidecars; defaults to STORAGE_DIR. */
	dir?: string;
	/** Told once per unreadable sidecar, after its text has been kept at `keptAt`. */
	onUnreadable?: (filePath: string, keptAt: string) => void;
	/** Told once per sidecar holding invalid comments, after they were kept at `keptAt`. */
	onInvalid?: (filePath: string, count: number, keptAt: string) => void;
	/** Told once per note whose sidecar a newer plugin wrote, which is then read-only. */
	onNewerFormat?: (filePath: string) => void;
}

/** Said when a newer plugin wrote a note's comments, so a refused change is not a mystery. */
export function describeNewerFormat(filePath: string): string {
	return `Comments for ${noteName(filePath)} were saved by a newer version of Margin Comments. They are read-only until the plugin is updated.`;
}

/** Thrown by any change to a note whose sidecar a newer plugin wrote. */
export class NewerFormatError extends Error {
	constructor(readonly filePath: string) {
		super(describeNewerFormat(filePath));
	}
}

/** Thrown by a change to a comment that is no longer stored: deleted since it was drawn. */
export class CommentNotFoundError extends Error {
	constructor(
		readonly filePath: string,
		readonly id: string,
	) {
		super("That comment was deleted, so the change was not saved.");
	}
}

/**
 * Said when a change to a note's comments did not land.
 *
 * Every write used to be fired off with `void` after the field had already been
 * cleared, so a rejection left the typed text gone and nothing on screen (#266).
 * The two causes we can name say what to do about them; anything else — a full
 * disk, permissions, a file a sync client holds — at least says the change was
 * not saved, which is the part the user cannot otherwise tell.
 */
export function describeFailedSave(filePath: string, error: unknown): string {
	if (error instanceof NewerFormatError || error instanceof CommentNotFoundError) {
		return error.message;
	}
	return `Comments for ${noteName(filePath)} could not be saved. Nothing was changed.`;
}

/** Said when a note's comments could not be read, so the loss is visible and recoverable. */
export function describeUnreadableSidecar(filePath: string, keptAt: string): string {
	return `Comments for ${noteName(filePath)} could not be read. Their file was kept as ${keptAt}.`;
}

/** Said when some of a note's comments were set aside, so they are not silently gone. */
export function describeInvalidComments(filePath: string, count: number, keptAt: string): string {
	const [noun, verb] = count === 1 ? ["comment", "was"] : ["comments", "were"];
	return `${count} ${noun} in ${noteName(filePath)} could not be read and ${verb} set aside in ${keptAt}.`;
}

/**
 * Lock order for `exclusive`, by code unit rather than by locale.
 *
 * What this order has to be is the same for every caller; what it must not be is
 * sensitive to anything outside the process, which is why localeCompare is wrong
 * here however much typescript:S2871 likes it. Sidecar names are hex and ".json",
 * so there is nothing for a locale to have an opinion about.
 */
const byCodeUnit = (a: string, b: string): number => {
	if (a < b) return -1;
	return a > b ? 1 : 0;
};

export class CommentStorage {
	private readonly cache = new Map<string, Comment[]>();
	private index: Index | null = null;
	/**
	 * Serialises each storage file's read, change and write; interleaved ones lose
	 * comments. Keyed by the file's path, so a change reported on disk (see
	 * changedOnDisk) waits for a write of this store's own to finish.
	 */
	private readonly queues = new Map<string, Promise<unknown>>();
	/** Notes whose sidecar a newer plugin wrote. See accept. */
	private readonly readOnly = new Set<string>();
	/** Set when a newer plugin wrote the index. See indexFrom. */
	private indexReadOnly = false;
	/**
	 * The text this store last read from or wrote to each storage file, null once the
	 * file is gone. It is what tells a change another device made apart from the file
	 * events this store's own writes fire.
	 */
	private readonly known = new Map<string, string | null>();
	/** Sidecars no index entry can be built from, so they are not re-read on every load. */
	private readonly unindexable = new Set<string>();

	/** Pending while moveTo runs, so no queued work starts against the folder being left. */
	private moving: Promise<void> = Promise.resolve();
	private folder: string;

	constructor(
		private readonly adapter: StorageAdapter,
		private readonly options: StorageOptions = {},
	) {
		this.folder = normalizePath(options.dir ?? STORAGE_DIR);
	}

	/** The storage folder; changes only through moveTo. */
	get dir(): string {
		return this.folder;
	}

	private sidecarPath(filePath: string): string {
		return normalizePath(`${this.dir}/${hashString(filePath)}.json`);
	}

	private indexPath(): string {
		return normalizePath(`${this.dir}/${INDEX_FILE}`);
	}

	/** Runs work after whatever is already queued for this note. */
	private enqueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(filePath) ?? Promise.resolve();
		const next = previous.then(work, work);
		this.queues.set(
			filePath,
			next.catch(() => undefined),
		);
		return next;
	}

	/**
	 * Runs work while holding the queue of every note it touches.
	 *
	 * The queues are taken in sorted order, not call order. A move holds two notes,
	 * and two moves in opposite directions — a rename undone before the first one
	 * finished — would otherwise each wait forever on the note the other holds.
	 */
	private exclusive<T>(filePaths: string[], work: () => Promise<T>): Promise<T> {
		// Paths are taken after any move, so they name the folder the work will run in.
		return this.moving.then(() => {
			const paths = [...new Set(filePaths.map((filePath) => this.sidecarPath(filePath)))];
			return this.holding([...paths].sort(byCodeUnit), work);
		});
	}

	private holding<T>(paths: string[], work: () => Promise<T>): Promise<T> {
		const [first, ...rest] = paths;
		if (first === undefined) return work();
		return this.enqueue(first, () => this.holding(rest, work));
	}

	/**
	 * Reads a note's comments, changes them and writes the result in one turn of its
	 * queue. Reading before the queue is what lost writes: two overlapping mutations
	 * read the same list, and the second write replaced the first.
	 *
	 * The read goes to disk, not to the cache. A sync client can change the sidecar
	 * after it was cached, and a change built on the cached list wrote over the
	 * comments it delivered (#260).
	 *
	 * `change` returns null to leave the note untouched. Resolves to the comments as
	 * they were before the change.
	 */
	private mutate(
		filePath: string,
		change: (existing: Comment[]) => Comment[] | null,
	): Promise<Comment[]> {
		return this.exclusive([filePath], async () => {
			this.cache.delete(filePath);
			const existing = await this.loadComments(filePath);
			this.refuseIfNewer(filePath);
			const next = change(existing);
			if (next) await this.writeComments(filePath, next);
			return existing;
		});
	}

	/**
	 * A note's comments, from the cache or its sidecar.
	 *
	 * A read that misses the cache waits its turn in the note's queue. Unqueued, a
	 * read that started before a save could finish after it and cache the list as it
	 * was, and the next save would build on that list and drop the first.
	 */
	async getCommentsForFile(filePath: string): Promise<Comment[]> {
		const cached = this.cache.get(filePath);
		if (cached) return cached;
		try {
			return await this.exclusive([filePath], () => this.loadComments(filePath));
		} catch (error) {
			// Refusing to draw a note is worse than drawing it without comments. Nothing
			// is cached, so the next read tries again, and a save still refuses to
			// replace a file it never managed to read.
			console.warn("margin-comments: could not read a sidecar", error);
			return [];
		}
	}

	/**
	 * The read itself, for code that already holds the note's queue. Throws when the
	 * adapter cannot read an existing sidecar, so no mutation writes over it.
	 */
	private async loadComments(filePath: string): Promise<Comment[]> {
		const cached = this.cache.get(filePath);
		if (cached) return cached;

		const path = this.sidecarPath(filePath);
		if (!(await this.adapter.exists(path))) {
			const recovered = await this.recoverReplacement(path);
			if (recovered) return this.accept(filePath, recovered);
			this.known.set(path, null);
			// A stale index entry survives a half-finished sync. Clearing it here,
			// where the miss is already paid for, keeps getCommentSummaries free of
			// an existence check per note — which is the whole point of the index.
			await this.forgetIfIndexed(filePath);
			return [];
		}

		const text = await this.adapter.read(path);
		this.known.set(path, text);
		const sidecar = parseSidecar(text);
		if (!sidecar || versionOf(sidecar) === null) {
			// A crash mid-write or a sync conflict leaves a sidecar that no longer parses,
			// sometimes one a person could still repair. Treating it as empty would let
			// the next save replace the only copy, so its text is kept first.
			console.warn(`margin-comments: setting aside unreadable sidecar ${basename(path)}`);
			const keptAt = await this.setAside(path, text);
			await this.forgetIfIndexed(filePath);
			this.options.onUnreadable?.(filePath, keptAt);
			return [];
		}

		return this.accept(filePath, sidecar);
	}

	/**
	 * Caches a note's valid comments and sets the others aside, rewriting the sidecar
	 * without them. They are kept before the rewrite, so a crash in between leaves them
	 * in two places rather than none.
	 */
	private async accept(filePath: string, sidecar: RawSidecar): Promise<Comment[]> {
		const valid = sidecar.comments.filter((c): c is Comment => isCommentOf(filePath, c));
		if ((versionOf(sidecar) ?? 0) > FORMAT_VERSION) {
			// Shown, never rewritten: what this version cannot read may be valid to the one
			// that wrote it, and a rewrite would drop every field this version does not know.
			// Said once: every change re-reads the sidecar, and would say it again.
			if (!this.readOnly.has(filePath)) this.options.onNewerFormat?.(filePath);
			this.readOnly.add(filePath);
			this.cache.set(filePath, valid);
			return valid;
		}
		if (valid.length === sidecar.comments.length) {
			this.cache.set(filePath, valid);
			return valid;
		}

		const invalid = sidecar.comments.filter((c) => !isCommentOf(filePath, c));
		const path = this.sidecarPath(filePath);
		console.warn(
			`margin-comments: setting aside ${invalid.length} invalid comments from ${basename(path)}`,
		);
		const keptAt = normalizePath(`${path}.invalid-${Date.now()}`);
		await this.adapter.write(keptAt, JSON.stringify({ filePath, comments: invalid }, null, 2));
		await this.writeComments(filePath, valid);
		this.options.onInvalid?.(filePath, invalid.length, keptAt);
		return valid;
	}

	/**
	 * Copies an unreadable sidecar's text beside it, then removes the original.
	 * Copied before removed, so a crash in between leaves two copies rather than none.
	 */
	private async setAside(path: string, text: string): Promise<string> {
		const keptAt = normalizePath(`${path}.unreadable-${Date.now()}`);
		await this.adapter.write(keptAt, text);
		this.known.set(path, null);
		await this.adapter.remove(path);
		return keptAt;
	}

	/**
	 * Replaces a file so that a crash never leaves it half-written.
	 *
	 * The text goes to a temporary file first, so a write that dies partway damages only
	 * that. Obsidian's adapter refuses to rename onto an existing file (measured on
	 * 1.13.7), so the original is removed before the move. A crash in that gap leaves
	 * the finished temporary file on its own, and recoverReplacement moves it into place
	 * on the next read.
	 */
	private async writeAtomically(path: string, data: string): Promise<void> {
		const temporary = `${path}.tmp`;
		await this.adapter.write(temporary, data);
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
		await this.adapter.rename(temporary, path);
	}

	/** Refuses a change to a note whose sidecar a newer plugin wrote. */
	private refuseIfNewer(filePath: string): void {
		if (this.readOnly.has(filePath)) throw new NewerFormatError(filePath);
	}

	/** A sidecar whose replacement was written but never moved into place, moved now. */
	private async recoverReplacement(path: string): Promise<RawSidecar | null> {
		const temporary = `${path}.tmp`;
		if (!(await this.adapter.exists(temporary))) return null;
		const text = await this.adapter.read(temporary);
		const sidecar = parseSidecar(text);
		// A partial one is from a write that died before it finished, so there is no
		// complete version to move into place.
		if (!sidecar || versionOf(sidecar) === null) return null;
		this.known.set(path, text);
		await this.adapter.rename(temporary, path);
		return sidecar;
	}

	async saveComment(comment: Comment): Promise<void> {
		await this.mutate(comment.filePath, (existing) => [...existing, comment]);
	}

	/**
	 * Changes one stored comment. `change` is handed the comment as stored now, inside
	 * the note's queue, so it builds on every change written before it. Taking a whole
	 * comment instead put back whatever the caller's copy held: an edit and then a
	 * resolve made from the same card lost the edit (#264).
	 *
	 * The comment keeps the id and note it was addressed by, whatever `change` returns.
	 * Rejects with CommentNotFoundError, writing nothing, once the comment is gone.
	 */
	async updateComment(
		filePath: string,
		id: string,
		change: (stored: Comment) => Comment,
	): Promise<void> {
		let found = false;
		await this.mutate(filePath, (existing) => {
			const next = existing.map((comment) => {
				if (comment.id !== id) return comment;
				found = true;
				return { ...change(comment), id, filePath };
			});
			return found ? next : null;
		});
		if (!found) throw new CommentNotFoundError(filePath, id);
	}

	async deleteComment(filePath: string, id: string): Promise<void> {
		// Deleting a thread root takes its replies with it: a reply whose root is
		// gone can never be displayed or re-anchored.
		await this.mutate(filePath, (existing) =>
			existing.filter((c) => c.id !== id && c.parentId !== id),
		);
	}

	/**
	 * Carry a note's comments to a new path, sidecar name and index entry included.
	 *
	 * The sidecar is named after a hash of the path, so a renamed note stops
	 * finding its own comments unless they are rewritten here. `filePath` is
	 * rewritten on every comment too: it is what a rebuild reads when the index
	 * is gone, and a stale one would send the comments back to the dead path.
	 *
	 * Written to the new path before the old one is cleared. A crash in between
	 * leaves the comments in two places, which the next rebuild resolves; the
	 * other order leaves them nowhere.
	 *
	 * Anything already at the target is kept rather than overwritten. Obsidian
	 * will not rename a note onto an existing one, so a sidecar there belongs to
	 * a note that is already gone — its comments are orphaned, not disposable.
	 *
	 * The whole move holds both notes' queues, because keeping the target's
	 * comments is what makes overlapping moves dangerous. Obsidian emits a folder
	 * rename once for the folder and again for every descendant, so the same note
	 * genuinely arrives twice. Unqueued, the second mover read the comments off the
	 * still-present source, between the target being written and the source being
	 * removed, and appended them to the target it had just found them in. Queued,
	 * it finds the source already empty.
	 */
	async moveComments(from: string, to: string): Promise<void> {
		if (from === to) return;

		await this.exclusive([from, to], async () => {
			// From disk, for the reason mutate gives.
			this.cache.delete(from);
			this.cache.delete(to);
			const moving = await this.loadComments(from);
			this.refuseIfNewer(from);
			if (moving.length === 0) return;

			const existing = await this.loadComments(to);
			this.refuseIfNewer(to);
			await this.writeComments(to, [
				...existing,
				...moving.map((c) => ({ ...c, filePath: to })),
			]);
			await this.writeComments(from, []);
		});
	}

	/**
	 * Remove a note's comments and hand them back.
	 *
	 * For a caller that will hold on to them — deleting a note takes its comments
	 * with it, and the only thing that makes that safe is being able to put them
	 * back. Returning them rather than dropping them is what keeps the store from
	 * being the last place they existed.
	 */
	private heldPath(filePath: string): string {
		return normalizePath(`${this.dir}/${HELD_DIR}/${hashString(filePath)}.json`);
	}

	/**
	 * Set a note's comments aside, off the note but still on disk.
	 *
	 * Written before the sidecar is cleared, so a crash in between leaves two
	 * copies rather than none — the same order `setAside` uses. Both inside the
	 * note's queue, so moveTo cannot copy the folder between the two and then
	 * delete the held file it never saw.
	 *
	 * Merged rather than replaced when something is already held: a note deleted
	 * twice in one session came back in between, and the second delete carries
	 * the newer set.
	 */
	async holdComments(filePath: string): Promise<Comment[]> {
		return this.exclusive([filePath], async () => {
			this.cache.delete(filePath);
			const taken = await this.loadComments(filePath);
			this.refuseIfNewer(filePath);
			if (taken.length === 0) return [];

			const path = this.heldPath(filePath);
			const held = await this.readHeld(path);
			const known = new Set(held.map((comment) => comment.id));
			const merged = [...held, ...taken.filter((comment) => !known.has(comment.id))];

			await this.ensureDir();
			const dir = normalizePath(`${this.dir}/${HELD_DIR}`);
			if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
			const sidecar: Sidecar = { version: FORMAT_VERSION, filePath, comments: merged };
			await this.adapter.write(path, JSON.stringify(sidecar, null, 2));
			await this.writeComments(filePath, []);
			return taken;
		});
	}

	/** What is held for a note, and stop holding it. Null when nothing is. */
	async releaseComments(filePath: string): Promise<Comment[] | null> {
		return this.exclusive([filePath], async () => {
			const path = this.heldPath(filePath);
			if (!(await this.adapter.exists(path))) return null;
			const held = await this.readHeld(path);
			await this.adapter.remove(path);
			return held.length === 0 ? null : held;
		});
	}

	private async readHeld(path: string): Promise<Comment[]> {
		if (!(await this.adapter.exists(path))) return [];
		const sidecar = parseSidecar(await this.adapter.read(path).catch(() => ""));
		if (!sidecar || !isText(sidecar.filePath)) return [];
		return sidecar.comments.filter((c): c is Comment =>
			isCommentOf(sidecar.filePath as string, c),
		);
	}

	async takeComments(filePath: string): Promise<Comment[]> {
		return this.mutate(filePath, (existing) => (existing.length === 0 ? null : []));
	}

	/**
	 * Put comments back on a note, keeping anything written since.
	 *
	 * A note can be deleted, recreated and commented on before the restore lands;
	 * replacing would throw that comment away.
	 */
	async restoreComments(filePath: string, comments: Comment[]): Promise<void> {
		if (comments.length === 0) return;
		await this.mutate(filePath, (existing) => {
			const known = new Set(existing.map((comment) => comment.id));
			return [...existing, ...comments.filter((comment) => !known.has(comment.id))];
		});
	}

	/**
	 * Replaces a note's comments on disk. Only safe inside that note's queue: it does
	 * not take the queue itself, because every caller already holds it and taking it
	 * again would wait on itself.
	 */
	private async writeComments(filePath: string, comments: Comment[]): Promise<void> {
		const path = this.sidecarPath(filePath);

		if (comments.length === 0) {
			this.cache.delete(filePath);
			this.known.set(path, null);
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
			await this.updateIndex((index) => {
				delete index[filePath];
			});
			return;
		}

		await this.ensureDir();
		const sidecar: Sidecar = { version: FORMAT_VERSION, filePath, comments };
		const text = JSON.stringify(sidecar, null, 2);
		this.known.set(path, text);
		await this.writeAtomically(path, text);
		this.cache.set(filePath, comments);
		await this.updateIndex((index) => {
			index[filePath] = { hash: hashString(filePath), ...summarise(comments) };
		});
	}

	private async ensureDir(): Promise<void> {
		const dir = this.dir;
		if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}

	/**
	 * Every note carrying comments, with its counts, read from the index alone.
	 *
	 * No sidecar is opened and no path is stat-ed: a vault with hundreds of
	 * commented notes would otherwise pay that round trip before the view could
	 * draw its first row.
	 */
	async getCommentSummaries(): Promise<CommentSummary[]> {
		const index = await this.loadIndex();
		return Object.entries(index).map(([filePath, entry]) => ({
			filePath,
			threads: entry.threads,
			open: entry.open,
		}));
	}

	private async forgetIfIndexed(filePath: string): Promise<void> {
		const index = await this.loadIndex();
		if (!(filePath in index)) return;
		await this.updateIndex((current) => {
			delete current[filePath];
		});
	}

	private async loadIndex(): Promise<Index> {
		if (this.index) return this.index;

		const path = this.indexPath();
		let index: Index;
		try {
			const raw = await this.adapter.read(path);
			this.known.set(path, raw);
			index = await this.indexFrom(JSON.parse(raw) as Record<string, unknown>);
		} catch {
			// The index is a derived cache, never the source of truth. Rebuilding from
			// the sidecars themselves is always correct, so a missing or corrupt index
			// is a non-event.
			index = await this.rebuildIndex();
		}
		await this.addUnlisted(index);
		this.index = index;
		return index;
	}

	/**
	 * The index a parsed `_index.json` holds, or one rebuilt from the sidecars.
	 *
	 * An index a newer plugin wrote is rebuilt in memory and never written back. 0.1
	 * stored a bare hash per note; reading those as zero threads would show every
	 * existing vault an empty all-notes view, so the counts are recovered the only way
	 * they can be: from the sidecars.
	 */
	private async indexFrom(parsed: Record<string, unknown>): Promise<Index> {
		const version = versionOf(parsed);
		if (version === null) return this.rebuildIndex();
		if (version > FORMAT_VERSION) {
			this.indexReadOnly = true;
			return this.rebuildIndex();
		}
		const notes = version === 0 ? parsed : parsed.notes;
		if (typeof notes !== "object" || notes === null) return this.rebuildIndex();
		return Object.values(notes).every(isEntry) ? (notes as Index) : this.rebuildIndex();
	}

	private async rebuildIndex(): Promise<Index> {
		const index: Index = {};
		await this.addUnlisted(index);
		return index;
	}

	/**
	 * Adds every sidecar the index does not list. Rebuilding is this with an empty index.
	 *
	 * A sidecar and the index sync as two separate files, so one another device wrote
	 * can arrive without the entry that lists it, or lose that entry to a conflict. The
	 * all-notes view reads the index alone, and never showed such a note (#260). It costs
	 * one directory listing; a sidecar is read only when nothing lists it.
	 */
	/**
	 * How many sidecars have been set aside, and where they are.
	 *
	 * A sidecar that cannot be read, or that holds comments the plugin cannot use,
	 * is renamed rather than deleted: the data outlives the failure. Nothing ever
	 * mentioned those files again, so on a vault with a noisy sync they piled up
	 * inside a hidden folder nobody opens (#318). Counting them is cheap — one
	 * directory listing, no reads — and it is the difference between data that was
	 * kept and data that was quietly lost.
	 */
	async countSetAside(): Promise<{ count: number; folder: string }> {
		const folder = this.dir;
		if (!(await this.adapter.exists(folder))) return { count: 0, folder };
		const { files } = await this.adapter.list(folder);
		return { count: files.filter((path) => SET_ASIDE.test(path)).length, folder };
	}

	private async addUnlisted(index: Index): Promise<void> {
		const dir = this.dir;
		if (!(await this.adapter.exists(dir))) return;

		const listed = new Set(Object.keys(index).map((filePath) => this.sidecarPath(filePath)));
		const { files } = await this.adapter.list(dir);
		for (const path of files) {
			if (!this.isSidecar(path) || listed.has(path) || this.unindexable.has(path)) continue;
			// Skipped, not set aside: the note it belongs to is named inside the text
			// that failed to parse, so it is set aside once that note is opened.
			const sidecar = parseSidecar(await this.adapter.read(path).catch(() => ""));
			const filePath = sidecar && isText(sidecar.filePath) ? sidecar.filePath : null;
			// A file not named after its own note was copied or renamed by hand. Indexed
			// under the note it claims, the vault view would list a note whose sidecar does
			// not exist.
			if (sidecar === null || filePath === null || path !== this.sidecarPath(filePath)) {
				this.unindexable.add(path);
				continue;
			}
			index[filePath] = {
				hash: hashString(filePath),
				...summarise(
					sidecar.comments.filter((c): c is Comment => isCommentOf(filePath, c)),
				),
			};
		}
	}

	/** Whether `path` is where a sidecar lives: a `.json` directly in the storage folder, not the index. */
	private isSidecar(path: string): boolean {
		const prefix = `${this.dir}/`;
		return (
			path.startsWith(prefix) &&
			path.endsWith(".json") &&
			!path.slice(prefix.length).includes("/") &&
			path !== this.indexPath()
		);
	}

	private async readIfPresent(path: string): Promise<string | null> {
		try {
			return (await this.adapter.exists(path)) ? await this.adapter.read(path) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Moves every comment to another storage folder, losing none (ADR 0001, D2/D3).
	 *
	 * Waits for every queued change, and holds back new ones until it is done. Each
	 * file is copied, then every copy is read back and compared, and only then does
	 * the store switch folder and delete the source. Any failure before the switch
	 * throws with the folder unchanged and the source untouched. After it, nothing
	 * throws for the cleanup: what could not be removed is listed in `leftInSource`,
	 * and a move from the source again finishes it. Callers persist `storage.dir`
	 * rather than the target they asked for, and do so even when this rejects: once
	 * `dir` is the target, that is where new comments are written. Only adapter calls,
	 * no folder rename, because mobile adapters have none that works across folders.
	 *
	 * A target that already holds this plugin's files (Sync delivering another
	 * device's) is merged per note by comment id. A sidecar either side holds in a
	 * newer format, or that does not parse, is never rewritten: both copies stay where
	 * they are, so the source folder survives the move.
	 */
	async moveTo(target: string): Promise<MoveResult> {
		const previous = this.moving;
		let release = (): void => undefined;
		this.moving = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await previous;
			await Promise.all(this.queues.values());
			return await this.relocate(target);
		} finally {
			release();
		}
	}

	private async relocate(target: string): Promise<MoveResult> {
		const from = this.dir;
		const to = this.checkTarget(target);
		const existing = await this.contentsOf(to);
		const foreign = existing.find((relative) => kindOf(relative) === null);
		if (foreign !== undefined) {
			throw new StorageMoveError(
				"foreign-file",
				`${to} already holds ${foreign}, which is not a comment file.`,
			);
		}

		const result: MoveResult = { moved: 0, merged: 0, keptBoth: 0, leftInSource: [] };
		const copies: Array<[path: string, text: string]> = [];
		const copied: Array<[relative: string, kind: FileKind, text: string]> = [];
		for (const relative of await this.contentsOf(from)) {
			const kind = kindOf(relative);
			// Left in place: someone else's file, which also keeps the source folder.
			if (kind === null) continue;
			let text = "";
			if (kind !== "index") {
				text = await this.adapter.read(`${from}/${relative}`);
				const outcome = await this.copy(kind, `${to}/${relative}`, text, copies);
				result[outcome]++;
				if (outcome === "keptBoth") {
					result.leftInSource.push(`${from}/${relative}`);
					continue;
				}
			}
			copied.push([relative, kind, text]);
		}

		for (const [path, text] of copies) {
			if ((await this.adapter.read(path)) !== text) {
				throw new StorageMoveError("unverified", `${path} did not read back as written.`);
			}
		}

		this.folder = to;
		this.cache.clear();
		this.known.clear();
		this.unindexable.clear();
		this.readOnly.clear();
		this.queues.clear();
		this.index = null;
		this.indexReadOnly = false;
		// From here the comments are safe in the target, so a failure is reported, not thrown.
		const warn = (error: unknown) =>
			console.warn("margin-comments: could not clear the old storage folder", error);
		await this.dropIndex().catch(warn);

		for (const [relative, kind, text] of copied) {
			const path = `${from}/${relative}`;
			const cleared = await this.clear(path, `${to}/${relative}`, kind, text).catch(
				(error: unknown) => {
					warn(error);
					return false;
				},
			);
			if (!cleared) result.leftInSource.push(path);
		}
		for (const folder of [`${from}/${HELD_DIR}`, from]) {
			await this.removeIfEmpty(folder).catch((error: unknown) => {
				warn(error);
				result.leftInSource.push(`${folder}/`);
			});
		}
		return result;
	}

	private copy(
		kind: FileKind,
		path: string,
		text: string,
		copies: Array<[string, string]>,
	): Promise<keyof Omit<MoveResult, "leftInSource">> {
		return kind === "raw"
			? this.copyRaw(path, text, copies)
			: this.copySidecar(path, text, copies);
	}

	/**
	 * Removes a source file once it still holds what was copied; true when it is gone.
	 *
	 * Re-read first because Sync can deliver another device's change between the copy
	 * and this delete, and deleting by the text read earlier dropped it. A changed file
	 * is merged into the target again and verified; one that keeps changing is left.
	 * A change landing between this read and the remove is still possible, but the
	 * window is one adapter call rather than the whole move.
	 */
	private async clear(
		path: string,
		target: string,
		kind: FileKind,
		copiedText: string,
	): Promise<boolean> {
		let expected = copiedText;
		for (let attempt = 0; attempt < 3; attempt++) {
			const now = await this.readOrNull(path);
			if (now === null) return true;
			if (kind === "index" || now === expected) {
				await this.adapter.remove(path);
				return true;
			}
			const copies: Array<[string, string]> = [];
			if ((await this.copy(kind, target, now, copies)) === "keptBoth") return false;
			for (const [copy, text] of copies) {
				if ((await this.adapter.read(copy)) !== text) return false;
			}
			expected = now;
		}
		return false;
	}

	/** The normalized target, or a StorageMoveError saying why it cannot be one. */
	private checkTarget(target: string): string {
		const to = normalizePath(target);
		if (/[/\\]/.test(target) || to === "" || to === "." || to === "..") {
			throw new StorageMoveError(
				"not-root-folder",
				`${target} is not a single folder at the vault root.`,
			);
		}
		// Folded, because on a case-insensitive disk "Comments" and "comments" are one
		// folder, and deleting the source would delete what was just copied.
		const fold = (name: string) => name.normalize("NFC").toLowerCase();
		if (fold(to) === fold(this.dir)) {
			throw new StorageMoveError("same-folder", `Comments are already stored in ${to}.`);
		}
		return to;
	}

	/** Every file under a storage folder, relative to it; a stray subfolder counts as one. */
	private async contentsOf(folder: string): Promise<string[]> {
		if (!(await this.adapter.exists(folder))) return [];
		const { files, folders } = await this.adapter.list(folder);
		const found = files.map((path) => path.slice(folder.length + 1));
		for (const sub of folders) {
			const relative = sub.slice(folder.length + 1);
			if (relative !== HELD_DIR) {
				found.push(`${relative}/`);
				continue;
			}
			const held = await this.adapter.list(sub);
			found.push(...held.files.map((path) => path.slice(folder.length + 1)));
			found.push(...held.folders.map((path) => `${path.slice(folder.length + 1)}/`));
		}
		return found;
	}

	/** Read without swallowing errors: a target file that cannot be read must not be replaced. */
	private async readOrNull(path: string): Promise<string | null> {
		return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
	}

	private async writeCopy(
		path: string,
		text: string,
		copies: Array<[string, string]>,
	): Promise<void> {
		const parent = path.slice(0, path.lastIndexOf("/"));
		const root = parent.slice(0, `${parent}/`.indexOf("/"));
		for (const folder of new Set([root, parent])) {
			if (!(await this.adapter.exists(folder))) await this.adapter.mkdir(folder);
		}
		await this.adapter.write(path, text);
		copies.push([path, text]);
	}

	private async copySidecar(
		path: string,
		text: string,
		copies: Array<[string, string]>,
	): Promise<keyof Omit<MoveResult, "leftInSource">> {
		const there = await this.readOrNull(path);
		if (there === null) {
			await this.writeCopy(path, text, copies);
			return "moved";
		}
		if (there === text) {
			copies.push([path, text]);
			return "moved";
		}
		const ours = parseSidecar(text);
		const theirs = parseSidecar(there);
		const mergeable = (sidecar: RawSidecar | null): sidecar is RawSidecar => {
			const version = sidecar === null ? null : versionOf(sidecar);
			return version !== null && version <= FORMAT_VERSION;
		};
		if (!mergeable(ours) || !mergeable(theirs) || ours.filePath !== theirs.filePath) {
			return "keptBoth";
		}
		const merged: Sidecar = {
			version: FORMAT_VERSION,
			filePath: theirs.filePath as string,
			comments: mergeComments(theirs.comments, ours.comments) as Comment[],
		};
		const mergedText = JSON.stringify(merged, null, 2);
		if (mergedText === there) copies.push([path, there]);
		else await this.writeCopy(path, mergedText, copies);
		return "merged";
	}

	/** A file copied as it is, beside a different one of the same name rather than over it. */
	private async copyRaw(
		path: string,
		text: string,
		copies: Array<[string, string]>,
	): Promise<keyof Omit<MoveResult, "leftInSource">> {
		for (let n = 0; ; n++) {
			const candidate = n === 0 ? path : `${path}-${n}`;
			const there = await this.readOrNull(candidate);
			if (there === text) {
				copies.push([candidate, text]);
				return "moved";
			}
			if (there === null) {
				await this.writeCopy(candidate, text, copies);
				return "moved";
			}
		}
	}

	/** Removes the index the target held, so it is rebuilt from the merged sidecars. */
	private async dropIndex(): Promise<void> {
		const path = this.indexPath();
		// A crash mid-write left it; recoverReplacement never looks at the index's.
		if (await this.adapter.exists(`${path}.tmp`)) await this.adapter.remove(`${path}.tmp`);
		const text = await this.readOrNull(path);
		if (text === null) return;
		let version: number | null = null;
		try {
			const parsed = JSON.parse(text) as { version?: unknown } | null;
			version = parsed === null ? null : versionOf(parsed);
		} catch {
			// Unparseable: a derived cache, so it is simply dropped.
		}
		// A newer plugin's index is left alone; this version rebuilds it in memory anyway.
		if (version !== null && version > FORMAT_VERSION) return;
		await this.adapter.remove(path);
	}

	private async removeIfEmpty(folder: string): Promise<void> {
		if (!(await this.adapter.exists(folder))) return;
		const { files, folders } = await this.adapter.list(folder);
		if (files.length === 0 && folders.length === 0) await this.adapter.rmdir(folder, false);
	}

	/**
	 * Told that a file changed on disk, answers whether it was news, and forgets what
	 * the change made stale.
	 *
	 * News means the file no longer holds what this store last read or wrote there:
	 * something outside the plugin changed it, most likely a sync client delivering
	 * another device's comments (#260). This store's own writes fire the same file
	 * events and answer false, so they cost one read and no redraw. Checked in the
	 * file's own queue, so a write of this store's is never read half done.
	 */
	async changedOnDisk(path: string): Promise<boolean> {
		const changed = normalizePath(path);
		await this.moving;
		const isIndex = changed === this.indexPath();
		if (!isIndex && !this.isSidecar(changed)) return false;

		return this.enqueue(changed, async () => {
			const text = await this.readIfPresent(changed);
			if (this.known.has(changed) && this.known.get(changed) === text) return false;
			this.known.delete(changed);
			// Either file can change what the all-notes view lists.
			this.index = null;
			if (isIndex) return true;

			this.unindexable.delete(changed);
			// Copied before iterating, because the body deletes from the map it is
			// walking. typescript:S7747 reads the spread as a pointless conversion;
			// without it this mutates the collection it is iterating.
			for (const filePath of [...this.cache.keys()]) {
				if (this.sidecarPath(filePath) !== changed) continue;
				this.cache.delete(filePath);
				this.readOnly.delete(filePath);
			}
			return true;
		});
	}

	/**
	 * Changes the index inside its own queue. Every note writes it from that note's
	 * queue, so two saves to different notes would otherwise race on the one file:
	 * a count lost, or a rename finding its temporary file already moved away.
	 *
	 * The index is re-read first rather than taken from the cache. Another device may
	 * have added notes to the file since, and writing the cached copy back dropped
	 * them (#260). A newer plugin's index is never written, so it is not re-read.
	 */
	private async updateIndex(mutate: (index: Index) => void): Promise<void> {
		await this.enqueue(this.indexPath(), async () => {
			if (!this.indexReadOnly) this.index = null;
			const index = await this.loadIndex();
			mutate(index);
			this.index = index;
			// A newer plugin's index is only read; the counts stay current in memory.
			if (this.indexReadOnly) return;
			await this.ensureDir();
			const text = JSON.stringify({ version: FORMAT_VERSION, notes: index }, null, 2);
			this.known.set(this.indexPath(), text);
			await this.writeAtomically(this.indexPath(), text);
		});
	}
}

/**
 * What a file under a storage folder is, by its path relative to the folder; null for
 * anything this plugin never writes there.
 */
type FileKind = "index" | "sidecar" | "held" | "raw";

function kindOf(relative: string): FileKind | null {
	if (relative === INDEX_FILE || relative === `${INDEX_FILE}.tmp`) return "index";
	if (/^[^/]+\.json$/.test(relative)) return "sidecar";
	if (
		relative.startsWith(`${HELD_DIR}/`) &&
		/^[^/]+\.json$/.test(relative.slice(HELD_DIR.length + 1))
	) {
		return "held";
	}
	if (/^[^/]+\.json(\.tmp|\.(invalid|unreadable)-\d+)(-\d+)*$/.test(relative)) return "raw";
	return null;
}
