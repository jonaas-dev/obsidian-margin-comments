import { MarkdownView, Notice, Platform, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { CommentStorage } from "./storage";
import { commentGutter, updateCommentedLines } from "./editor/hover-gutter";
import { linesWithOpenComments } from "./editor/gutter-state";

export default class InlineCommentsPlugin extends Plugin {
	storage!: CommentStorage;

	async onload(): Promise<void> {
		this.storage = new CommentStorage(this.app.vault.adapter);

		this.registerEditorExtension(
			commentGutter({
				// No hover on touch devices, so the affordance has to be permanent.
				alwaysVisible: Platform.isMobile,
				onActivate: (view, line) => this.onGutterClick(view, line),
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => void this.refreshMarkers()),
		);
		this.registerEvent(this.app.workspace.on("editor-change", () => void this.refreshMarkers()));

		this.app.workspace.onLayoutReady(() => void this.refreshMarkers());
	}

	/** Placeholder until the floating editor lands in #10. */
	private onGutterClick(_view: EditorView, line: number): void {
		new Notice(`Inline Comments: line ${line}`);
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
