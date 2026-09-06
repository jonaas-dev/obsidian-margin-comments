import { MarkdownView, Platform, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { CommentStorage } from "./storage";
import { createAnchor } from "./anchor";
import { commentGutter, updateCommentedLines } from "./editor/hover-gutter";
import { linesWithOpenComments } from "./editor/gutter-state";
import { FloatingComposer } from "./editor/floating-comment";
import { DEFAULT_SETTINGS, type Comment, type PluginSettings } from "./types";

export default class InlineCommentsPlugin extends Plugin {
	storage!: CommentStorage;
	settings: PluginSettings = DEFAULT_SETTINGS;
	private composer: FloatingComposer | null = null;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.storage = new CommentStorage(this.app.vault.adapter);

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
			this.app.workspace.on("active-leaf-change", () => void this.refreshMarkers()),
		);
		this.registerEvent(this.app.workspace.on("editor-change", () => void this.refreshMarkers()));
		this.app.workspace.onLayoutReady(() => void this.refreshMarkers());
	}

	onunload(): void {
		this.composer?.close();
		this.composer = null;
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
		await this.refreshMarkers();
	}

	private async refreshMarkers(): Promise<void> {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = this.app.workspace.getActiveFile();
		if (!markdownView || !file) return;

		const comments = await this.storage.getCommentsForFile(file.path);
		const lines = linesWithOpenComments(markdownView.editor.getValue(), comments);

		// Obsidian exposes the CodeMirror view here but does not declare it, and
		// it is absent in the legacy editor, so this stays defensive.
		const view = (markdownView.editor as unknown as { cm?: EditorView }).cm;
		if (view) updateCommentedLines(view, lines);
	}
}
