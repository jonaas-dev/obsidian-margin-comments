import { MarkdownView, Platform, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { CommentStorage } from "./storage";
import { createAnchor } from "./anchor";
import { commentGutter, updateCommentedLines } from "./editor/hover-gutter";
import { linesWithOpenComments } from "./editor/gutter-state";
import { highlightRanges, lineHighlights, updateHighlights } from "./editor/line-highlight";
import { FloatingComposer } from "./editor/floating-comment";
import { DEFAULT_SETTINGS, type Comment, type PluginSettings } from "./types";
import { COMMENT_PANEL_VIEW, CommentPanelView } from "./ui/comment-panel";
import { buildThreads, type Thread } from "./ui/threads";
import { createReply } from "./ui/replies";
import { withEditedContent, withResolved } from "./ui/comment-actions";

export default class InlineCommentsPlugin extends Plugin {
	storage!: CommentStorage;
	settings: PluginSettings = DEFAULT_SETTINGS;
	private composer: FloatingComposer | null = null;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.storage = new CommentStorage(this.app.vault.adapter);

		this.registerView(
			COMMENT_PANEL_VIEW,
			(leaf) =>
				new CommentPanelView(leaf, {
					loadActive: () => this.loadActive(),
					revealThread: (thread) => this.revealThread(thread),
					replyTo: (target, near) => this.openReplyComposer(target, near),
					editComment: (comment, content) => this.editComment(comment, content),
					setResolved: (root, resolved) => this.setResolved(root, resolved),
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

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.refresh()));
		this.registerEvent(this.app.workspace.on("editor-change", () => void this.refresh()));
		this.app.workspace.onLayoutReady(() => void this.refresh());
	}

	onunload(): void {
		this.composer?.close();
		this.composer = null;
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

	private openReplyComposer(target: Comment, near: HTMLElement): void {
		const rect = near.getBoundingClientRect();
		this.composer?.close();
		this.composer = new FloatingComposer({
			anchorRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
			placeholder: "Write a reply…",
			submitLabel: "Reply",
			onSubmit: async (content) => {
				await this.storage.saveComment(createReply(target, content, this.settings.author));
				await this.refresh();
			},
			onCancel: () => {
				this.composer = null;
			},
		});
		this.composer.open();
	}

	private async editComment(comment: Comment, content: string): Promise<void> {
		await this.storage.updateComment(withEditedContent(comment, content));
		await this.refresh();
	}

	private async setResolved(root: Comment, resolved: boolean): Promise<void> {
		await this.storage.updateComment(withResolved(root, resolved));
		await this.refresh();
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
		if (threads.some((thread) => thread.line === line)) {
			await this.openPanel();
			return;
		}
		this.compose(view, line, filePath);
	}

	private async openPanel(): Promise<void> {
		if (this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW).length === 0) {
			await this.togglePanel();
		}
		await this.refreshPanel();
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
