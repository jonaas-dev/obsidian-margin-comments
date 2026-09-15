import { normalizePath } from "obsidian";
import type { Comment, TextAnchor } from "./types";
import { hashString, noteName } from "./utils";

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

export const STORAGE_DIR = ".margin-comments";
export const INDEX_FILE = "_index.json";

/**
 * The slice of Obsidian's DataAdapter this plugin uses.
 *
 * Everything goes through the adapter rather than the Vault API because
 * STORAGE_DIR is a dotfolder, and the Vault API skips those: vault.create,
 * vault.getAbstractFileByPath and the vault change events would all miss it.
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

export interface StorageOptions {
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

/** Said when a note's comments could not be read, so the loss is visible and recoverable. */
export function describeUnreadableSidecar(filePath: string, keptAt: string): string {
	return `Comments for ${noteName(filePath)} could not be read. Their file was kept as ${keptAt}.`;
}

/** Said when some of a note's comments were set aside, so they are not silently gone. */
export function describeInvalidComments(filePath: string, count: number, keptAt: string): string {
	const [noun, verb] = count === 1 ? ["comment", "was"] : ["comments", "were"];
	return `${count} ${noun} in ${noteName(filePath)} could not be read and ${verb} set aside in ${keptAt}.`;
}

export class CommentStorage {
	private cache = new Map<string, Comment[]>();
	private index: Index | null = null;
	/**
	 * Serialises each storage file's read, change and write; interleaved ones lose
	 * comments. Keyed by the file's path, so a change reported on disk (see
	 * changedOnDisk) waits for a write of this store's own to finish.
	 */
	private queues = new Map<string, Promise<unknown>>();
	/** Notes whose sidecar a newer plugin wrote. See accept. */
	private readOnly = new Set<string>();
	/** Set when a newer plugin wrote the index. See indexFrom. */
	private indexReadOnly = false;
	/**
	 * The text this store last read from or wrote to each storage file, null once the
	 * file is gone. It is what tells a change another device made apart from the file
	 * events this store's own writes fire.
	 */
	private known = new Map<string, string | null>();
	/** Sidecars no index entry can be built from, so they are not re-read on every load. */
	private unindexable = new Set<string>();

	constructor(
		private adapter: StorageAdapter,
		private options: StorageOptions = {},
	) {}

	private sidecarPath(filePath: string): string {
		return normalizePath(`${STORAGE_DIR}/${hashString(filePath)}.json`);
	}

	private indexPath(): string {
		return normalizePath(`${STORAGE_DIR}/${INDEX_FILE}`);
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
		const paths = [...new Set(filePaths.map((filePath) => this.sidecarPath(filePath)))];
		return this.holding(paths.sort(), work);
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
		console.warn(`margin-comments: setting aside ${invalid.length} invalid comments from ${basename(path)}`);
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

	async updateComment(comment: Comment): Promise<void> {
		await this.mutate(comment.filePath, (existing) =>
			existing.map((c) => (c.id === comment.id ? comment : c)),
		);
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
		const dir = normalizePath(STORAGE_DIR);
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
	private async addUnlisted(index: Index): Promise<void> {
		const dir = normalizePath(STORAGE_DIR);
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
				...summarise(sidecar.comments.filter((c): c is Comment => isCommentOf(filePath, c))),
			};
		}
	}

	/** Whether `path` is where a sidecar lives: a `.json` directly in STORAGE_DIR, not the index. */
	private isSidecar(path: string): boolean {
		const prefix = `${normalizePath(STORAGE_DIR)}/`;
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
