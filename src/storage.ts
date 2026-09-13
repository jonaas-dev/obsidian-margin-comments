import { normalizePath } from "obsidian";
import type { Comment } from "./types";
import { hashString } from "./utils";

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
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/** One note's comments, as stored. */
interface Sidecar {
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

export class CommentStorage {
	private cache = new Map<string, Comment[]>();
	private index: Index | null = null;
	/** Serialises each note's read, change and write; interleaved ones lose comments. */
	private queues = new Map<string, Promise<unknown>>();

	constructor(private adapter: StorageAdapter) {}

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
		const [first, ...rest] = [...new Set(filePaths)].sort();
		if (first === undefined) return work();
		return this.enqueue(first, () => this.exclusive(rest, work));
	}

	/**
	 * Reads a note's comments, changes them and writes the result in one turn of its
	 * queue. Reading before the queue is what lost writes: two overlapping mutations
	 * read the same list, and the second write replaced the first.
	 *
	 * `change` returns null to leave the note untouched. Resolves to the comments as
	 * they were before the change.
	 */
	private mutate(
		filePath: string,
		change: (existing: Comment[]) => Comment[] | null,
	): Promise<Comment[]> {
		return this.exclusive([filePath], async () => {
			const existing = await this.loadComments(filePath);
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
		return (
			this.cache.get(filePath) ??
			this.exclusive([filePath], () => this.loadComments(filePath))
		);
	}

	/** The read itself, for code that already holds the note's queue. */
	private async loadComments(filePath: string): Promise<Comment[]> {
		const cached = this.cache.get(filePath);
		if (cached) return cached;

		const path = this.sidecarPath(filePath);
		if (!(await this.adapter.exists(path))) {
			// A stale index entry survives a half-finished sync. Clearing it here,
			// where the miss is already paid for, keeps getCommentSummaries free of
			// an existence check per note — which is the whole point of the index.
			await this.forgetIfIndexed(filePath);
			return [];
		}

		const sidecar = await this.readSidecar(path);
		const comments = sidecar?.comments ?? [];
		this.cache.set(filePath, comments);
		return comments;
	}

	private async readSidecar(path: string): Promise<Sidecar | null> {
		try {
			const parsed = JSON.parse(await this.adapter.read(path)) as Sidecar;
			if (!Array.isArray(parsed?.comments)) throw new Error("missing comments array");
			return parsed;
		} catch (error) {
			// A sync conflict can corrupt one sidecar. Losing that note's comments is
			// bad; refusing to load the plugin at all is worse.
			console.warn(`margin-comments: skipping unreadable sidecar ${basename(path)}`, error);
			return null;
		}
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
			const moving = await this.loadComments(from);
			if (moving.length === 0) return;

			const existing = await this.loadComments(to);
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
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
			await this.updateIndex((index) => {
				delete index[filePath];
			});
			return;
		}

		await this.ensureDir();
		const sidecar: Sidecar = { filePath, comments };
		await this.adapter.write(path, JSON.stringify(sidecar, null, 2));
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

		try {
			const raw = await this.adapter.read(this.indexPath());
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			// 0.1 stored a bare hash per note. Reading those as zero threads would
			// show every existing vault an empty all-files view, so the counts are
			// recovered the only way they can be: from the sidecars.
			this.index = Object.values(parsed).every(isEntry)
				? (parsed as Index)
				: await this.rebuildIndex();
		} catch {
			// The index is a derived cache, never the source of truth. Rebuilding from
			// the sidecars themselves is always correct, so a missing or corrupt index
			// is a non-event.
			this.index = await this.rebuildIndex();
		}
		return this.index;
	}

	private async rebuildIndex(): Promise<Index> {
		const index: Index = {};
		const dir = normalizePath(STORAGE_DIR);
		if (!(await this.adapter.exists(dir))) return index;

		const { files } = await this.adapter.list(dir);
		for (const path of files) {
			if (path.endsWith(INDEX_FILE) || !path.endsWith(".json")) continue;
			const sidecar = await this.readSidecar(path);
			if (!sidecar?.filePath) continue;
			index[sidecar.filePath] = {
				hash: hashString(sidecar.filePath),
				...summarise(sidecar.comments),
			};
		}
		return index;
	}

	private async updateIndex(mutate: (index: Index) => void): Promise<void> {
		const index = await this.loadIndex();
		mutate(index);
		await this.ensureDir();
		await this.adapter.write(this.indexPath(), JSON.stringify(index, null, 2));
	}
}
