import { MarkdownView, Notice, Platform, Plugin, TFile, type TAbstractFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { CommentStorage } from "./storage";
import { createAnchor } from "./anchor";
import { movesFor } from "./note-moves";
import { HIGHLIGHT_VARIABLE, highlightOverride } from "./appearance";
import { DeletedNotes, describeNoteDeletion, describeNoteRestore } from "./deleted-notes";
import { commentGutter, updateCommentedLines, updateGutterEnabled } from "./editor/hover-gutter";
import { linesWithOpenComments } from "./editor/gutter-state";
import { highlightRanges, lineHighlights, updateHighlights } from "./editor/line-highlight";
import { FloatingComposer } from "./editor/floating-comment";
import type { AnchorRect } from "./editor/floating-position";
import {
	DEFAULT_SETTINGS,
	type Comment,
	type PanelScope,
	type PluginSettings,
	type SortOrder,
} from "./types";
import { COMMENT_PANEL_VIEW, CommentPanelView, type NoteData } from "./ui/comment-panel";
import { buildSections, toPanelScope, type VaultSection } from "./ui/vault-sections";
import { toThreadFilter, type ThreadFilter } from "./ui/panel-filter";
import { toSortOrder } from "./ui/panel-sort";
import { ThreadPopover } from "./ui/thread-popover";
import { buildThreads, type Thread } from "./ui/threads";
import { OrphanNotice, orphanCount } from "./ui/orphans";
import { createReply } from "./ui/replies";
import {
	describeDeletion,
	describeResolveAll,
	openRoots,
	withEditedContent,
	withResolved,
} from "./ui/comment-actions";
import { findAdjacentLine, type Direction } from "./editor/comment-navigation";
import { ConfirmModal } from "./ui/confirm-modal";

/** Put the cursor on a 1-based line and scroll it into view. */
function goToLine(view: MarkdownView, line: number): void {
	const position = { line: line - 1, ch: 0 };
	view.editor.setCursor(position);
	view.editor.scrollIntoView({ from: position, to: position }, true);
	view.editor.focus();
}

export default class InlineCommentsPlugin extends Plugin {
	storage!: CommentStorage;
	settings: PluginSettings = DEFAULT_SETTINGS;
	private composer: FloatingComposer | null = null;
	private popover: ThreadPopover | null = null;
	/** Note the open popover belongs to, so a genuine note switch closes it. */
	private popoverFile: string | null = null;
	/** Owned by the plugin, not the panel: the panel is rebuilt on every close
	 *  and reopen, and the notice has to stay silent across both. */
	private orphanNotice = new OrphanNotice();
	/** Comments waiting for their note to come back. See DeletedNotes. */
	private deleted = new DeletedNotes();

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// data.json survives across versions and can be hand-edited, so the stored
		// filter is validated rather than trusted.
		this.settings.panelFilter = toThreadFilter(this.settings.panelFilter);
		this.settings.sortOrder = toSortOrder(this.settings.sortOrder);
		this.settings.panelScope = toPanelScope(this.settings.panelScope);
		this.storage = new CommentStorage(this.app.vault.adapter);
		this.popover = new ThreadPopover(this.app, {
			addReply: (root, content) => this.addReply(root, content),
			editComment: (comment, content) => this.editComment(comment, content),
			setResolved: (root, resolved) => this.setResolved(root, resolved),
			deleteComment: (comment) => this.confirmDelete(comment),
		});
		this.addChild(this.popover);

		this.registerView(
			COMMENT_PANEL_VIEW,
			(leaf) =>
				new CommentPanelView(leaf, {
					loadActive: () => this.loadActive(),
					revealThread: (thread) => this.revealThread(thread),
					addReply: (root, content) => this.addReply(root, content),
					editComment: (comment, content) => this.editComment(comment, content),
					setResolved: (root, resolved) => this.setResolved(root, resolved),
					deleteComment: (comment) => this.confirmDelete(comment),
					closePanel: () => this.app.workspace.detachLeavesOfType(COMMENT_PANEL_VIEW),
					filter: () => this.settings.panelFilter,
					setFilter: (filter) => this.setPanelFilter(filter),
					sortOrder: () => this.settings.sortOrder,
					setSortOrder: (order) => this.setSortOrder(order),
					fuzzyThreshold: () => this.settings.fuzzyThreshold,
					scope: () => this.settings.panelScope,
					setScope: (scope) => this.setPanelScope(scope),
					loadVault: () => this.loadVault(),
					loadNote: (filePath) => this.loadNote(filePath),
					openThreadInNote: (filePath, thread) => void this.openThreadInNote(filePath, thread),
					notifyOrphans: (count) => this.announceOrphans(count),
				}),
		);

		this.addRibbonIcon("message-square", "Toggle comments panel", () => void this.togglePanel());
		this.addCommand({
			id: "toggle-comments-panel",
			name: "Toggle comments panel",
			callback: () => void this.togglePanel(),
		});

		this.applyHighlightColour();
		this.registerEditorExtension(lineHighlights());
		this.registerEditorExtension(
			commentGutter({
				alwaysVisible: Platform.isMobile,
				onActivate: (view, line) => this.openComposer(view, line),
			}),
		);

		this.addCommand({
			id: "add-comment",
			name: "Add comment to selection",
			// Mod+Shift+M is free in a default Obsidian, and every binding here is
			// a default: Obsidian's hotkey settings override all of them.
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "M" }],
			editorCallback: (_editor, ctx) => {
				const view = (ctx as MarkdownView).editor as unknown as { cm?: EditorView };
				if (view.cm) this.openComposer(view.cm, view.cm.state.doc.lineAt(view.cm.state.selection.main.head).number);
			},
		});

		// Editor-scoped, so they grey out anywhere that is not a note.
		this.addCommand({
			id: "next-comment",
			name: "Go to next comment",
			editorCallback: (_editor, ctx) => void this.jumpToComment(ctx as MarkdownView, "next"),
		});

		this.addCommand({
			id: "previous-comment",
			name: "Go to previous comment",
			editorCallback: (_editor, ctx) => void this.jumpToComment(ctx as MarkdownView, "previous"),
		});

		this.addCommand({
			id: "resolve-all-comments",
			name: "Resolve all comments in this note",
			editorCallback: (_editor, ctx) => this.confirmResolveAll(ctx as MarkdownView),
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				// Not on every refresh: the click that opens the popover also stirs
				// the workspace, and closing there shut it the instant it appeared.
				const path = this.app.workspace.getActiveFile()?.path ?? null;
				if (path !== this.popoverFile) this.popover?.close();
				void this.refresh();
				void this.checkOrphans();
			}),
		);
		this.registerEvent(this.app.workspace.on("editor-change", () => void this.refresh()));
		// vault.on rather than a workspace event: a note can be renamed from the
		// file explorer with nothing open, and the comments still have to follow.
		this.registerEvent(
			this.app.vault.on("rename", (file, from) => void this.followRename(from, file.path)),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => void this.followDelete(file)));
		this.registerEvent(this.app.vault.on("create", (file) => void this.followCreate(file)));
		this.app.workspace.onLayoutReady(() => {
			void this.refresh();
			void this.checkOrphans();
		});
	}

	onunload(): void {
		this.composer?.close();
		this.composer = null;
		this.popover?.close();
		// The custom property is set on a document the plugin does not own, so
		// leaving it behind would keep tinting lines after the plugin is gone.
		document.body.style.removeProperty(HIGHLIGHT_VARIABLE);
	}

	/**
	 * Publish the chosen highlight colour to the stylesheet.
	 *
	 * A custom property rather than inline styles on each decoration: the
	 * decorations are rebuilt on every keystroke, and the colour is not a
	 * per-line fact. Removing it hands the line back to the theme accent, which
	 * is what the stylesheet falls back to.
	 */
	applyHighlightColour(): void {
		const override = highlightOverride(this.settings.highlightColor);
		if (override === null) document.body.style.removeProperty(HIGHLIGHT_VARIABLE);
		else document.body.style.setProperty(HIGHLIGHT_VARIABLE, override);
	}

	private async togglePanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW);
		if (existing.length > 0) {
			this.app.workspace.detachLeavesOfType(COMMENT_PANEL_VIEW);
			return;
		}
		const leaf =
			this.settings.panelPosition === "left"
				? this.app.workspace.getLeftLeaf(false)
				: this.app.workspace.getRightLeaf(false);
		await leaf?.setViewState({ type: COMMENT_PANEL_VIEW, active: true });
		if (leaf) this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * The MarkdownView showing `path`, if one is open.
	 *
	 * getActiveViewOfType is not usable here: focusing the panel makes it the
	 * active view, so the note the panel is describing stops being "active" the
	 * instant anyone clicks the panel.
	 */
	private markdownViewFor(path: string): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) return view;
		}
		return null;
	}

	/**
	 * Move comments to wherever their note went.
	 *
	 * A folder rename arrives as several overlapping events — the folder, then
	 * every descendant — so the same note is handled more than once. That is
	 * safe because `moveComments` refuses a second move of a note it is already
	 * moving; nothing here needs to sequence the events itself.
	 *
	 * Renaming a note that carries no comments moves nothing and costs one
	 * index read.
	 */
	private async followRename(from: string, to: string): Promise<void> {
		const summaries = await this.storage.getCommentSummaries();
		const moves = movesFor(
			summaries.map((summary) => summary.filePath),
			from,
			to,
		);
		if (moves.length === 0) return;

		for (const move of moves) await this.storage.moveComments(move.from, move.to);
		await this.refresh();
	}

	/**
	 * Take a note's comments with it when it is deleted, recoverably.
	 *
	 * Only the file events matter: a folder carries no comments of its own, and
	 * Obsidian was measured emitting a delete for every note underneath it. If
	 * that ever stopped, the comments would stay behind and show as a "not found"
	 * note in the all-notes view — visible, not lost — which is why this needs no
	 * folder cascade where the rename handler does.
	 */
	private async followDelete(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		if (this.settings.orphanedBehavior === "keep") {
			await this.refresh();
			return;
		}

		const comments = await this.storage.takeComments(file.path);
		if (comments.length === 0) return;

		this.deleted.remember(file.path, comments);
		new Notice(describeNoteDeletion(file.path, comments.length));
		await this.refresh();
	}

	/**
	 * Give a note back its comments when it reappears.
	 *
	 * Restoring from the trash is routine, and some sync setups present a rename
	 * as delete-then-create; both arrive here. Obsidian also fires create for
	 * every file while it indexes a vault at startup, which is harmless: nothing
	 * is held yet, so every one of those is a map lookup that misses.
	 */
	private async followCreate(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") return;

		const comments = this.deleted.recover(file.path);
		if (comments === null) return;

		await this.storage.restoreComments(file.path, comments);
		new Notice(describeNoteRestore(file.path, comments.length));
		await this.refresh();
	}

	/**
	 * Look for lost anchors in the note just opened, once a session.
	 *
	 * Deliberately not wired to editor-change: this is the only path outside the
	 * panel that runs the fuzzy stage, and paying for it per keystroke is the
	 * cost that stage was bounded to avoid. Arriving at a note is both cheap
	 * enough and the moment the news is actually new.
	 *
	 * Skipped entirely once the announcement is spent, so the pass costs nothing
	 * for the rest of the session rather than running to be thrown away.
	 */
	private async checkOrphans(): Promise<void> {
		if (this.orphanNotice.spent) return;

		const active = await this.loadActive();
		if (!active) return;
		const threads = buildThreads(active.doc, active.comments, {
			fuzzy: true,
			threshold: this.settings.fuzzyThreshold,
		});
		this.announceOrphans(orphanCount(threads));
	}

	/** Say once that comments lost their anchor; the panel shows which. */
	private announceOrphans(count: number): void {
		const message = this.orphanNotice.take(count);
		if (message !== null) new Notice(message);
	}

	private async setPanelFilter(filter: ThreadFilter): Promise<void> {
		this.settings.panelFilter = filter;
		await this.saveData(this.settings);
	}

	private async setPanelScope(scope: PanelScope): Promise<void> {
		this.settings.panelScope = scope;
		await this.saveData(this.settings);
	}

	private async setSortOrder(order: SortOrder): Promise<void> {
		this.settings.sortOrder = order;
		await this.saveData(this.settings);
	}

	private async addReply(root: Comment, content: string): Promise<void> {
		await this.storage.saveComment(createReply(root, content, this.settings.author));
		await this.refresh();
	}

	private async editComment(comment: Comment, content: string): Promise<void> {
		await this.storage.updateComment(withEditedContent(comment, content));
		await this.refresh();
	}

	private async setResolved(root: Comment, resolved: boolean): Promise<void> {
		await this.storage.updateComment(withResolved(root, resolved));
		await this.refresh();
	}

	private confirmDelete(comment: Comment): void {
		void (async () => {
			const all = await this.storage.getCommentsForFile(comment.filePath);
			new ConfirmModal(this.app, describeDeletion(comment, all), async () => {
				await this.storage.deleteComment(comment.filePath, comment.id);
				await this.refresh();
			}).open();
		})();
	}

	private async loadActive(): Promise<{
		filePath: string;
		doc: string;
		comments: Comment[];
	} | null> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		// Prefer the open editor over the file on disk: it holds unsaved edits,
		// and anchoring against stale text would strand comments that still match.
		const view = this.markdownViewFor(file.path);
		const doc = view ? view.editor.getValue() : await this.app.vault.cachedRead(file);
		return {
			filePath: file.path,
			doc,
			comments: await this.storage.getCommentsForFile(file.path),
		};
	}

	/** Every commented note, with the ones the vault no longer has marked. */
	private async loadVault(): Promise<VaultSection[]> {
		const summaries = await this.storage.getCommentSummaries();
		// getAbstractFileByPath is an in-memory lookup, so this stays free of I/O
		// even on a vault with hundreds of commented notes.
		return buildSections(summaries, (path) => this.app.vault.getAbstractFileByPath(path) !== null);
	}

	/**
	 * One note's text and comments.
	 *
	 * A missing note yields empty text rather than nothing at all: every comment
	 * on it then reads as orphaned, which is exactly what it is, and it can still
	 * be read and deleted.
	 */
	private async loadNote(filePath: string): Promise<NoteData> {
		const comments = await this.storage.getCommentsForFile(filePath);
		const view = this.markdownViewFor(filePath);
		if (view) return { doc: view.editor.getValue(), comments };

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return { doc: "", comments };
		return { doc: await this.app.vault.cachedRead(file), comments };
	}

	/** Open another note and put the cursor on the thread's line. */
	private async openThreadInNote(filePath: string, thread: Thread): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile) || thread.line === null) return;

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		if (leaf.view instanceof MarkdownView) goToLine(leaf.view, thread.line);
	}

	private revealThread(thread: Thread): void {
		const file = this.app.workspace.getActiveFile();
		const view = file ? this.markdownViewFor(file.path) : null;
		if (!view || thread.line === null) return;
		goToLine(view, thread.line);
	}

	/** Move the cursor to the next or previous commented line in this note. */
	private async jumpToComment(view: MarkdownView, direction: Direction): Promise<void> {
		if (!view.file) return;

		const comments = await this.storage.getCommentsForFile(view.file.path);
		const threads = buildThreads(view.editor.getValue(), comments);
		// Orphans have no line to jump to. Skipping them silently is right: the
		// panel is where a lost comment gets dealt with, not the editor.
		const lines = threads
			.map((thread) => thread.line)
			.filter((line): line is number => line !== null);

		const target = findAdjacentLine(lines, view.editor.getCursor().line + 1, direction);
		if (target === null) {
			new Notice("No comments in this note.");
			return;
		}
		goToLine(view, target);
	}

	/**
	 * Resolve every open thread in the note, after saying how many.
	 *
	 * Confirmed even though resolving is reversible: this is the one action here
	 * that touches comments the user is not looking at.
	 */
	private confirmResolveAll(view: MarkdownView): void {
		void (async () => {
			if (!view.file) return;
			const filePath = view.file.path;
			const open = openRoots(await this.storage.getCommentsForFile(filePath));
			if (open.length === 0) {
				new Notice("No open comments in this note.");
				return;
			}

			new ConfirmModal(
				this.app,
				describeResolveAll(open.length),
				async () => {
					for (const root of open) {
						await this.storage.updateComment(withResolved(root, true));
					}
					await this.refresh();
				},
				{
					confirmLabel: "Resolve",
					note: "Every thread can be reopened afterwards.",
					destructive: false,
				},
			).open();
		})();
	}

	private async refreshPanel(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW)) {
			await (leaf.view as CommentPanelView).render();
		}
	}

	private async refresh(): Promise<void> {
		await this.refreshMarkers();
		await this.refreshPanel();
	}

	/**
	 * Comment the selection, or the whole line when there is none.
	 *
	 * The anchor is built from the document as it stands now, so what gets stored
	 * is the text the author was actually looking at.
	 */
	private openComposer(view: EditorView, line: number): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		void this.showExistingOrCompose(view, line, file.path);
	}

	/**
	 * Clicking a line that already has comments should show them, not silently
	 * start a second one — reading is the more common intent, and there was no
	 * way to read a comment at all before the panel existed.
	 */
	private async showExistingOrCompose(
		view: EditorView,
		line: number,
		filePath: string,
	): Promise<void> {
		const comments = await this.storage.getCommentsForFile(filePath);
		const threads = buildThreads(view.state.doc.toString(), comments, {
			fuzzy: true,
			threshold: this.settings.fuzzyThreshold,
		});
		const thread = threads.find((candidate) => candidate.line === line);
		if (!thread) {
			this.compose(view, line, filePath);
			return;
		}

		// With the panel already open, selecting there keeps everything in one
		// place. With it closed, a popover beside the line beats yanking the
		// reader's attention across the window to a panel that just appeared.
		const panels = this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW);
		if (panels.length > 0) {
			for (const leaf of panels) {
				await (leaf.view as CommentPanelView).select(thread.root.id);
			}
			return;
		}

		this.popoverFile = filePath;
		this.popover?.open(thread, filePath, this.lineRect(view, line));
	}

	/** Screen rect of a line, for anchoring the popover. */
	private lineRect(view: EditorView, line: number): AnchorRect {
		const coords = view.coordsAtPos(view.state.doc.line(line).from);
		return coords
			? { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom }
			: { left: 0, right: 0, top: 0, bottom: 0 };
	}

	private compose(view: EditorView, line: number, filePath: string): void {
		const file = { path: filePath };

		const selection = view.state.selection.main;
		const lineInfo = view.state.doc.line(line);
		const [from, to] = selection.empty
			? [lineInfo.from, lineInfo.from]
			: [selection.from, selection.to];

		const coords = view.coordsAtPos(selection.empty ? lineInfo.from : selection.from);
		const anchorRect = coords
			? { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom }
			: { left: 0, right: 0, top: 0, bottom: 0 };

		this.composer?.close();
		this.composer = new FloatingComposer({
			anchorRect,
			onSubmit: async (content) => {
				await this.createComment(view, file.path, from, to, content);
			},
			onCancel: () => {
				this.composer = null;
			},
		});
		this.composer.open();
	}

	private async createComment(
		view: EditorView,
		filePath: string,
		from: number,
		to: number,
		content: string,
	): Promise<void> {
		const now = Date.now();
		const comment: Comment = {
			id: crypto.randomUUID(),
			filePath,
			anchor: createAnchor(view.state.doc.toString(), from, to),
			content,
			author: this.settings.author,
			createdAt: now,
			updatedAt: now,
			resolved: false,
			parentId: null,
		};
		await this.storage.saveComment(comment);
		await this.refresh();
	}

	private async refreshMarkers(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const markdownView = file ? this.markdownViewFor(file.path) : null;
		if (!markdownView || !file) return;

		const comments = await this.storage.getCommentsForFile(file.path);
		const doc = markdownView.editor.getValue();

		// Obsidian exposes the CodeMirror view here but does not declare it, and
		// it is absent in the legacy editor, so this stays defensive.
		const view = (markdownView.editor as unknown as { cm?: EditorView }).cm;
		if (!view) return;

		updateGutterEnabled(view, this.settings.showGutterIcons);
		updateCommentedLines(view, linesWithOpenComments(doc, comments));
		updateHighlights(view, this.settings.showLineHighlights ? highlightRanges(doc, comments) : []);
	}
}
