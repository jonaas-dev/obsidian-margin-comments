/**
 * In-memory stand-in for Obsidian's DataAdapter.
 *
 * Storage cannot be tested against the real Vault API at all: `.margin-comments/`
 * is a dotfolder, and the Vault API skips those. This fake implements the adapter
 * surface the plugin actually uses, and records every write so a test can prove
 * no Markdown file was ever touched.
 */
export class MemoryAdapter {
	private files = new Map<string, string>();
	private dirs = new Set<string>();
	/** Every path ever written to, in order. */
	readonly writes: string[] = [];
	/** Every path ever read, in order. Proves what a call did *not* touch. */
	readonly reads: string[] = [];

	constructor(seed: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(seed)) {
			this.files.set(path, content);
		}
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}

	async read(path: string): Promise<string> {
		this.reads.push(path);
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`ENOENT: ${path}`);
		return content;
	}

	async write(path: string, content: string): Promise<void> {
		this.writes.push(path);
		this.files.set(path, content);
	}

	async remove(path: string): Promise<void> {
		if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
	}

	/** Refuses an existing destination, as Obsidian's adapter does (measured on 1.13.7). */
	async rename(from: string, to: string): Promise<void> {
		const content = this.files.get(from);
		if (content === undefined) throw new Error(`ENOENT: ${from}`);
		if (this.files.has(to)) throw new Error("Destination file already exists!");
		this.files.delete(from);
		this.files.set(to, content);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files = [...this.files.keys()].filter(
			(p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
		);
		return { files, folders: [] };
	}

	/** Test helper: current contents, for asserting on what landed on disk. */
	snapshot(): Record<string, string> {
		return Object.fromEntries(this.files);
	}
}
