import { MarkdownView, type App, type MarkdownPostProcessorContext } from "obsidian";
import type { CommentStorage } from "../storage";
import type { Comment, PluginSettings } from "../types";
import type { AnchorRect } from "../editor/floating-position";
import type { CommentPanelView } from "../ui/comment-panel";
import { buildThreads, type Thread } from "../threads";
import { hashString } from "../utils";
import { highlightsInBlock } from "./reading-highlights";
import {
	markBlock,
	paintReadingMarks,
	threadIdsAt,
	unmarkBlock,
	READING_BLOCK_CLASS,
	READING_MARK_CLASS,
} from "./reading-marks";

/** What reading mode needs from the plugin. */
export interface ReadingModeHost {
	app: App;
	storage: CommentStorage;
	settings(): Pick<PluginSettings, "showLineHighlights" | "fuzzyThreshold">;
	/** The panel, if it is loaded and on screen. */
	visiblePanel(): CommentPanelView | null;
	/** Whether threads open as a bottom sheet. */
	sheet(): boolean;
	/** `owner` is the document of the window the reader acted in. */
	openPopover(threads: Thread[], filePath: string, rect: AnchorRect, doc: string, owner: Document): void;
}

/** Comments in reading mode: marks on the rendered note, and threads opened from them. */
export class ReadingMode {
	/** Threads resolved for reading mode, keyed by note path and text digest. See threadsFor. */
	private readonly threads = new Map<string, Thread[]>();

	constructor(private readonly host: ReadingModeHost) {}

	/**
	 * Forget every resolved thread.
	 *
	 * The cache is keyed by the note's text, so an edit misses it on its own. A
	 * resolve does not: same text, different comments.
	 */
	clear(): void {
		this.threads.clear();
	}

	/**
	 * Re-render every note's reading view, whether it is the visible mode or not.
	 *
	 * A post-processor runs when Obsidian renders a block and never again, so
	 * nothing else brings a resolve or a settings change to a note being read.
	 *
	 * Not only the leaves currently showing preview, which is what this did
	 * first: Obsidian reuses a cached render when returning to reading mode, and
	 * it invalidates that cache when the *note* changes. Comments live outside
	 * the note, so a comment added while editing left the cached render standing
	 * and switching to reading mode showed the note without it. Measured with the
	 * post-processor instrumented: on the second switch it was not called once.
	 */
	rerender(): void {
		for (const leaf of this.host.app.workspace.getLeavesOfType("markdown")) {
			(leaf.view as MarkdownView).previewMode?.rerender(true);
		}
	}

	/**
	 * Mark the commented text in one rendered block.
	 *
	 * Reading mode gets highlights and no gutter: CodeMirror extensions do not
	 * apply here, so there is no line to click. A comment is created in editing
	 * mode or from the panel, and an existing one opens from its mark (#171).
	 *
	 * `getSectionInfo` is what makes this possible and also what keeps it in
	 * bounds — it answers only for elements rendered as part of a file, so the
	 * Markdown the panel renders inside its own cards falls straight through
	 * rather than highlighting the comments' own text.
	 */
	async markBlock(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		if (!this.host.settings().showLineHighlights) return;

		const info = ctx.getSectionInfo(el);
		if (!info) return;
		// Cleared before deciding, not only added: a re-render can hand back the
		// same section element, and every early return below would otherwise leave
		// the rule from the last pass on a block whose thread is now resolved.
		unmarkBlock(el);

		const comments = await this.host.storage.getCommentsForFile(ctx.sourcePath);
		if (comments.length === 0) return;

		const threads = this.threadsFor(ctx.sourcePath, info.text, comments);
		const highlights = highlightsInBlock(info.text, threads, info.lineStart, info.lineEnd);
		if (highlights.length === 0) return;
		const ids = highlights.map((highlight) => highlight.id);

		// A code block gets the rule on its section, never spans in its code: marks
		// painted into the code did not reach the screen, so a commented code block
		// showed nothing at all while the editor highlighted it (#141).
		if (el.querySelector("pre")) {
			markBlock(el, ids);
			return;
		}

		if (paintReadingMarks(el, highlights) === 0) markBlock(el, ids);
	}

	/**
	 * Open the threads under a tap on a comment's mark in reading mode (#171).
	 *
	 * Reading mode has no gutter, so the marked words are the way in, routed as a
	 * gutter click is: the panel's card when the panel is on screen, the popover
	 * otherwise. A link inside a mark keeps its click, and a click that ends a text
	 * selection was a selection.
	 *
	 * The DOM is read before the first await: a refresh can re-render the note in
	 * the meantime and detach the element that was tapped.
	 */
	async openFrom(event: MouseEvent): Promise<void> {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (target.closest("a, button, input, textarea, select")) return;
		if (!(target.ownerDocument.defaultView?.getSelection()?.isCollapsed ?? true)) return;

		const ids = threadIdsAt(target);
		if (ids.length === 0) return;
		const leaf = this.host.app.workspace
			.getLeavesOfType("markdown")
			.find((candidate) => candidate.view.containerEl.contains(target));
		if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
		const filePath = leaf.view.file.path;
		const doc = leaf.view.editor.getValue();
		const marked = target.closest(`.${READING_MARK_CLASS}, .${READING_BLOCK_CLASS}`) ?? target;
		const rect = marked.getBoundingClientRect();

		const comments = await this.host.storage.getCommentsForFile(filePath);
		const threads = buildThreads(doc, comments, {
			fuzzy: true,
			threshold: this.host.settings().fuzzyThreshold,
		});
		const shown = ids
			.map((id) => threads.find((thread) => thread.root.id === id))
			.filter((thread): thread is Thread => thread !== undefined)
			.filter((thread) => !thread.root.resolved && !thread.orphaned);
		if (shown.length === 0) return;

		const panel = this.host.visiblePanel();
		if (panel) {
			await panel.select(shown[0].root.id);
			return;
		}

		// What keepAboveSheet does for the editor: the sheet covers the lower half
		// of the screen, where tapped words near the bottom would be left hidden.
		const scroller = this.host.sheet() ? marked.closest(".markdown-preview-view") : null;
		if (scroller) scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - 96;

		this.host.openPopover(
			shown,
			filePath,
			{ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
			doc,
			marked.ownerDocument,
		);
	}

	/**
	 * The note's threads, resolved once per render rather than once per block.
	 *
	 * Reading mode calls the post-processor for every block, and the fuzzy stage
	 * this shares with the panel searches the whole note for every comment. Paid
	 * per block on a long note it is the stage-2 hole from #22 all over again.
	 */
	private threadsFor(path: string, doc: string, comments: Comment[]): Thread[] {
		const key = `${path}:${hashString(doc)}`;
		const cached = this.threads.get(key);
		if (cached) return cached;

		const threads = buildThreads(doc, comments, {
			fuzzy: true,
			threshold: this.host.settings().fuzzyThreshold,
		});
		// One note is being read at a time; the cap is only so a long session of
		// edit-and-read does not hold every version of the note it passed through.
		if (this.threads.size >= 8) this.threads.clear();
		this.threads.set(key, threads);
		return threads;
	}
}
