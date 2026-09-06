import { MarkdownView, Platform, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { CommentStorage } from "./storage";
import { createAnchor } from "./anchor";
import { commentGutter, updateCommentedLines } from "./editor/hover-gutter";
import { linesWithOpenComments } from "./editor/gutter-state";
import { highlightRanges, lineHighlights, updateHighlights } from "./editor/line-highlight";
import { FloatingComposer } from "./editor/floating-comment";
import type { AnchorRect } from "./editor/floating-position";
import { DEFAULT_SETTINGS, type Comment, type PluginSettings } from "./types";
import { COMMENT_PANEL_VIEW, CommentPanelView } from "./ui/comment-panel";
import { ThreadPopover } from "./ui/thread-popover";
import { buildThreads, type Thread } from "./ui/threads";
import { createReply } from "./ui/replies";
import { describeDeletion, withEditedContent, withResolved } from "./ui/comment-actions";
import { ConfirmModal } from "./ui/confirm-modal";

export default class InlineCommentsPlugin extends Plugin {
	storage!: CommentStorage;
	settings: PluginSettings = DEFAULT_SETTINGS;
	private composer: FloatingComposer | null = null;
	private popover: ThreadPopover | null = null;
	/** Note the open popover belongs to, so a genuine note switch closes it. */
	private popoverFile: string | null = null;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
				}),
		);

		this.addRibbonIcon("message-square", "Toggle comments panel", () => void this.togglePanel());
		this.addCommand({
			id: "toggle-comments-panel",
			name: "Toggle comments panel",
			callback: () => void this.togglePanel(),
		});

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
			editorCallback: (_editor, ctx) => {
				const view = (ctx as MarkdownView).editor as unknown as { cm?: EditorView };
				if (view.cm) this.openComposer(view.cm, view.cm.state.doc.lineAt(view.cm.state.selection.main.head).number);
			},
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				// Not on every refresh: the click that opens the popover also stirs
				// the workspace, and closing there shut it the instant it appeared.
				const path = this.app.workspace.getActiveFile()?.path ?? null;
				if (path !== this.popoverFile) this.popover?.close();
				void this.refresh();
			}),
		);
		this.registerEvent(this.app.workspace.on("editor-change", () => void this.refresh()));
		this.app.workspace.onLayoutReady(() => void this.refresh());
	}

	onunload(): void {
		this.composer?.close();
		this.composer = null;
		this.popover?.close();
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

	private revealThread(thread: Thread): void {
		const file = this.app.workspace.getActiveFile();
		const view = file ? this.markdownViewFor(file.path) : null;
		if (!view || thread.line === null) return;
		view.editor.setCursor({ line: thread.line - 1, ch: 0 });
		view.editor.scrollIntoView(
			{ from: { line: thread.line - 1, ch: 0 }, to: { line: thread.line - 1, ch: 0 } },
			true,
		);
		view.editor.focus();
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
		const threads = buildThreads(view.state.doc.toString(), comments);
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

		updateCommentedLines(view, linesWithOpenComments(doc, comments));
		updateHighlights(view, this.settings.showLineHighlights ? highlightRanges(doc, comments) : []);
	}
}
