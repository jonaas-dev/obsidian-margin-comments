import type { ThreadFilter } from "./ui/panel-filter";

/** How a comment finds its text again after the note has been edited. */
export interface TextAnchor {
	/** The commented text. Empty for a whole-line comment. */
	selectedText: string;
	/** Digest of selectedText. Primary lookup key. */
	textHash: string;
	isLineComment: boolean;

	/** ~50 characters either side, used when the text itself was edited. */
	contextBefore: string;
	contextAfter: string;

	// Advisory only. These narrow the search; they are never the sole source of
	// truth, so a comment survives lines being inserted or deleted above it.
	lineHint: number;
	startOffset: number;
	endOffset: number;
}

export interface Comment {
	id: string;
	/** Vault-relative path of the note this belongs to. */
	filePath: string;
	anchor: TextAnchor;
	/** Markdown. */
	content: string;
	author: string;
	createdAt: number;
	/** Last activity of any kind, including resolving. Drives activity sorting. */
	updatedAt: number;
	/**
	 * When the body was last rewritten, if ever.
	 *
	 * Separate from updatedAt because that one moves on any change: deriving
	 * "edited" from it would label every resolved comment as edited too.
	 */
	editedAt?: number;
	/**
	 * Only meaningful on a thread root: resolving a root resolves its thread.
	 * Replies carry no independent resolved state.
	 */
	resolved: boolean;
	/**
	 * Thread root when null. A reply always points at the root, never at another
	 * reply — the model is deliberately flat, and the tree is derived at runtime.
	 */
	parentId: string | null;
}

export type HighlightColor = "theme" | (string & {});
export type OrphanedBehavior = "keep" | "delete";
export type SortOrder = "position" | "date" | "lastActivity";
export type PanelPosition = "right" | "left";

export interface PluginSettings {
	author: string;
	showGutterIcons: boolean;
	showLineHighlights: boolean;
	/** "theme" follows the Obsidian accent colour; anything else is a custom hex. */
	highlightColor: HighlightColor;
	fuzzyThreshold: number;
	orphanedBehavior: OrphanedBehavior;
	sortOrder: SortOrder;
	panelPosition: PanelPosition;
	showCommentCount: boolean;
	/**
	 * Which bucket the panel is showing. Persisted state rather than a setting —
	 * it is chosen in the panel, not in the settings tab, but it has to survive a
	 * reopen and a restart, and data.json is the only place that does.
	 */
	panelFilter: ThreadFilter;
}

export const FUZZY_THRESHOLD_MIN = 0.1;
export const FUZZY_THRESHOLD_MAX = 0.5;

export const DEFAULT_SETTINGS: PluginSettings = {
	// Empty rather than guessed: a wrong name stamped on every comment is worse
	// than an unattributed one, and the settings tab prompts for it.
	author: "",
	showGutterIcons: true,
	showLineHighlights: true,
	highlightColor: "theme",
	fuzzyThreshold: 0.3,
	orphanedBehavior: "keep",
	sortOrder: "position",
	panelPosition: "right",
	showCommentCount: true,
	panelFilter: "all",
};
