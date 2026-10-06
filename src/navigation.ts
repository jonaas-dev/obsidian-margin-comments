import { MarkdownView, Notice, TFile, type App } from "obsidian";
import type { CommentStorage } from "./storage";
import { COMMENT_PANEL_VIEW } from "./ui/comment-panel";
import { buildThreads, type Thread } from "./ui/threads";
import { findAdjacentLine, navigableLines, type Direction } from "./editor/comment-navigation";

/**
 * Put the cursor on a 1-based line and scroll it into view.
 *
 * `focus` lets a keyboard carry on from the line. On a touch device focus in the
 * editor is the on-screen keyboard, laid over the line just revealed (#157).
 */
function goToLine(view: MarkdownView, line: number, focus = true): void {
	const position = { line: line - 1, ch: 0 };
	view.editor.setCursor(position);
	view.editor.scrollIntoView({ from: position, to: position }, true);
	if (focus) view.editor.focus();
}

/** What moving the reader to a comment needs from the plugin. */
export interface NavigationHost {
	app: App;
	storage: CommentStorage;
	/** Whether this is a touch device. */
	touch(): boolean;
	/** Any one editor showing a note, or null. */
	markdownViewFor(path: string): MarkdownView | null;
}

/** Takes the reader to a comment: from a panel card, or to the next one in the note. */
export class Navigation {
	constructor(private readonly host: NavigationHost) {}

	/** Open another note and put the cursor on the thread's line. */
	async openThreadInNote(filePath: string, thread: Thread): Promise<void> {
		const file = this.host.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile) || thread.line === null) return;

		const leaf = this.host.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		this.getPanelOutOfTheWay();
		if (leaf.view instanceof MarkdownView) goToLine(leaf.view, thread.line, !this.host.touch());
	}

	/** Put the cursor on a thread's line in the note already open. */
	revealThread(thread: Thread): void {
		const file = this.host.app.workspace.getActiveFile();
		const view = file ? this.host.markdownViewFor(file.path) : null;
		if (!view || thread.line === null) return;
		this.getPanelOutOfTheWay();
		goToLine(view, thread.line, !this.host.touch());
	}

	/** Move the cursor to the next or previous commented line in this note. */
	async jumpToComment(view: MarkdownView, direction: Direction): Promise<void> {
		if (!view.file) return;

		const comments = await this.host.storage.getCommentsForFile(view.file.path);
		const lines = navigableLines(buildThreads(view.editor.getValue(), comments));

		const target = findAdjacentLine(lines, view.editor.getCursor().line + 1, direction);
		if (target === null) {
			// The same words as resolve-all: with every thread resolved, "no comments"
			// would be untrue.
			new Notice("No open comments in this note.");
			return;
		}
		goToLine(view, target);
	}

	/**
	 * On a touch device, collapse the sidebar holding the panel after it navigates.
	 *
	 * The sidebars there are drawers laid over the note, so a jump made from a
	 * card happened behind the panel and nothing on screen changed (#131). Pinned
	 * desktop sidebars sit beside the note, where closing one would be a surprise.
	 */
	private getPanelOutOfTheWay(): void {
		if (!this.host.touch()) return;
		const workspace = this.host.app.workspace;
		for (const leaf of workspace.getLeavesOfType(COMMENT_PANEL_VIEW)) {
			const root = leaf.getRoot();
			if (root === workspace.leftSplit) workspace.leftSplit.collapse();
			if (root === workspace.rightSplit) workspace.rightSplit.collapse();
		}
	}
}
