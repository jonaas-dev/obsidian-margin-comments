import { normalizePath } from "obsidian";
import type { Comment } from "./types";
import { hashString } from "./utils";

export const STORAGE_DIR = ".inline-comments";
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
	/** Serialises writes per sidecar; interleaved writes would lose comments. */
	private queues = new Map<string, Promise<unknown>>();
	/** Notes whose comments are mid-move. See moveComments. */
	private moving = new Set<string>();

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

	async getCommentsForFile(filePath: string): Promise<Comment[]> {
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
			console.warn(`inline-comments: skipping unreadable sidecar ${path}`, error);
			return null;
		}
	}

	async saveComment(comment: Comment): Promise<void> {
		const existing = await this.getCommentsForFile(comment.filePath);
		await this.writeComments(comment.filePath, [...existing, comment]);
	}

	async updateComment(comment: Comment): Promise<void> {
		const existing = await this.getCommentsForFile(comment.filePath);
		await this.writeComments(
			comment.filePath,
			existing.map((c) => (c.id === comment.id ? comment : c)),
		);
	}

	async deleteComment(filePath: string, id: string): Promise<void> {
		const existing = await this.getCommentsForFile(filePath);
		// Deleting a thread root takes its replies with it: a reply whose root is
		// gone can never be displayed or re-anchored.
		const remaining = existing.filter((c) => c.id !== id && c.parentId !== id);
		await this.writeComments(filePath, remaining);
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
	 * A second move of the same note is refused while one is in flight, because
	 * keeping the target's comments is what makes overlapping moves dangerous.
	 * Obsidian emits a folder rename once for the folder and again for every
	 * descendant, so the same note genuinely arrives twice; between the target
	 * being written and the source being removed, the second mover reads the
	 * comments off the still-present source and appends them to the target it
	 * just found them in. Reproduced, and covered by a test that fails without
	 * this line.
	 */
	async moveComments(from: string, to: string): Promise<void> {
		if (from === to || this.moving.has(from)) return;

		this.moving.add(from);
		try {
			const moving = await this.getCommentsForFile(from);
			if (moving.length === 0) return;

			const existing = await this.getCommentsForFile(to);
			await this.writeComments(to, [
				...existing,
				...moving.map((c) => ({ ...c, filePath: to })),
			]);
			await this.writeComments(from, []);
		} finally {
			this.moving.delete(from);
		}
	}

	private async writeComments(filePath: string, comments: Comment[]): Promise<void> {
		return this.enqueue(filePath, async () => {
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
