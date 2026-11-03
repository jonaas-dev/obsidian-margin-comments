/** Why a move to another storage folder was refused or abandoned. */
export type MoveRefusal = "same-folder" | "not-root-folder" | "foreign-file" | "unverified";

/**
 * Thrown by CommentStorage.moveTo before it switches folder: the storage folder is
 * unchanged and the source untouched. Whatever was already copied to the target is
 * a subset of the source, so running the move again merges it rather than doubling it.
 */
export class StorageMoveError extends Error {
	constructor(
		readonly reason: MoveRefusal,
		message: string,
	) {
		super(message);
	}
}

/** Counted per sidecar, held sidecars and set-aside files included. */
export interface MoveResult {
	/** Copied to a target that did not hold them, or already held them unchanged. */
	moved: number;
	/** Present on both sides and merged by comment id. */
	merged: number;
	/** Present on both sides and left as they were, because one side cannot be merged. */
	keptBoth: number;
}

function keyOf(comment: unknown): string {
	const id = (comment as { id?: unknown } | null)?.id;
	return typeof id === "string" && id !== "" ? `id:${id}` : `raw:${JSON.stringify(comment)}`;
}

function updatedAtOf(comment: unknown): number {
	const at = (comment as { updatedAt?: unknown } | null)?.updatedAt;
	return typeof at === "number" && Number.isFinite(at) ? at : -Infinity;
}

/**
 * One note's comments from two folders, as one list (ADR 0001, D3).
 *
 * Matched by id, and the later `updatedAt` wins; a tie keeps the target's, so merging
 * the result again changes nothing and an interrupted move can simply be re-run.
 * Comments are handled as opaque values: one this version would reject is carried
 * over untouched, and set aside by the store when its note is next read.
 */
export function mergeComments(target: unknown[], source: unknown[]): unknown[] {
	const merged = [...target];
	const at = new Map<string, number>();
	target.forEach((comment, i) => {
		if (!at.has(keyOf(comment))) at.set(keyOf(comment), i);
	});
	for (const comment of source) {
		const i = at.get(keyOf(comment));
		if (i === undefined) merged.push(comment);
		else if (updatedAtOf(comment) > updatedAtOf(merged[i])) merged[i] = comment;
	}
	return merged;
}
