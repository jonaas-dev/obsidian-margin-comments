import type { CommentSummary } from "../storage";
import type { PanelScope } from "../types";
import type { ThreadFilter } from "./panel-filter";

/** One note's row in the all-files view. */
export interface VaultSection extends CommentSummary {
	/** The note is indexed but no longer in the vault. */
	missing: boolean;
}

/**
 * Rows for the all-files view, in reading order.
 *
 * Sorted by path, with notes the vault no longer has last. Renaming a note
 * strands its sidecar until rename tracking lands, and hiding those comments
 * would look like data loss — naming them does not.
 */
export function buildSections(
	summaries: CommentSummary[],
	exists: (filePath: string) => boolean,
): VaultSection[] {
	return summaries
		.map((summary) => ({ ...summary, missing: !exists(summary.filePath) }))
		.sort((a, b) => {
			if (a.missing !== b.missing) return a.missing ? 1 : -1;
			return a.filePath.localeCompare(b.filePath);
		});
}

/** Notes with nothing in the chosen bucket drop out of the list entirely. */
export function filterSections(sections: VaultSection[], filter: ThreadFilter): VaultSection[] {
	if (filter === "all") return sections;
	if (filter === "open") return sections.filter((section) => section.open > 0);
	return sections.filter((section) => section.threads > section.open);
}

/** Threads across the whole vault, per bucket, straight from the index counts. */
export function countSections(sections: VaultSection[]): Record<ThreadFilter, number> {
	let all = 0;
	let open = 0;
	for (const section of sections) {
		all += section.threads;
		open += section.open;
	}
	return { all, open, resolved: all - open };
}

export function vaultEmptyStateMessage(filter: ThreadFilter): string {
	switch (filter) {
		case "all":
			return "No comments anywhere in this vault yet.";
		case "open":
			return "No open comments in this vault. Everything is resolved.";
		case "resolved":
			return "No resolved comments in this vault yet.";
	}
}

export const PANEL_SCOPES: readonly PanelScope[] = ["note", "vault"];

export function scopeLabel(scope: PanelScope): string {
	return scope === "note" ? "This note" : "All notes";
}

/** Read back a persisted scope, tolerating anything that is not one. */
export function toPanelScope(value: unknown): PanelScope {
	return PANEL_SCOPES.includes(value as PanelScope) ? (value as PanelScope) : "note";
}
