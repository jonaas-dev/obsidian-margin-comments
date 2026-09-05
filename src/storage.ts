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

type Index = Record<string, string>;

export class CommentStorage {
	private cache = new Map<string, Comment[]>();
	private index: Index | null = null;
	/** Serialises writes per sidecar; interleaved writes would lose comments. */
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

	async getCommentsForFile(filePath: string): Promise<Comment[]> {
		const cached = this.cache.get(filePath);
		if (cached) return cached;

		const path = this.sidecarPath(filePath);
		if (!(await this.adapter.exists(path))) return [];

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
				index[filePath] = hashString(filePath);
			});
		});
	}

	private async ensureDir(): Promise<void> {
		const dir = normalizePath(STORAGE_DIR);
		if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}

	/** Note paths that currently have comments, verified against what is on disk. */
	async getCommentedFiles(): Promise<string[]> {
		const index = await this.loadIndex();
		const present: string[] = [];
		for (const filePath of Object.keys(index)) {
			if (await this.adapter.exists(this.sidecarPath(filePath))) present.push(filePath);
		}
		return present;
	}

	private async loadIndex(): Promise<Index> {
		if (this.index) return this.index;

		try {
			const raw = await this.adapter.read(this.indexPath());
			this.index = JSON.parse(raw) as Index;
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
			if (sidecar?.filePath) index[sidecar.filePath] = hashString(sidecar.filePath);
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
