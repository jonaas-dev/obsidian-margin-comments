import { EditorView } from "@codemirror/view";
import { Notice, type App } from "obsidian";
import { describeFailedSave, type CommentStorage } from "../storage";
import type { Comment, PluginSettings } from "../types";
import type { CommentPanelView } from "../ui/comment-panel";
import { buildThreads, type Thread } from "../threads";
import { createAnchor } from "../anchor";
import { commentIntent } from "./comment-intent";
import { FloatingComposer } from "./floating-comment";
import type { AnchorRect } from "./floating-position";

/** What routing a comment request needs from the plugin. */
export interface ThreadRoutingHost {
	app: App;
	storage: CommentStorage;
	settings(): Pick<PluginSettings, "author" | "fuzzyThreshold">;
	/** The panel, if it is loaded and on screen. */
	visiblePanel(): CommentPanelView | null;
	/** Whether the composer and the popover open as a bottom sheet. */
	sheet(): boolean;
	/** `owner` is the document of the window the reader acted in. */
	openPopover(threads: Thread[], filePath: string, rect: AnchorRect, doc: string, owner: Document): void;
	refresh(): Promise<void>;
}

/** Answers a gutter press or the add-comment command: an existing thread, or the composer. */
export class ThreadRouting {
	private composer: FloatingComposer | null = null;

	constructor(private readonly host: ThreadRoutingHost) {}

	/** Close the composer, if one is open. */
	close(): void {
		this.composer?.close();
		this.composer = null;
	}

	/**
	 * Comment the selection, or the whole line when there is none.
	 *
	 * The anchor is built from the document as it stands now, so what gets stored
	 * is the text the author was actually looking at.
	 */
	open(view: EditorView, line: number, lastLine = line): void {
		const file = this.host.app.workspace.getActiveFile();
		if (!file) return;

		void this.showExistingOrCompose(view, line, file.path, lastLine);
	}

	/**
	 * Show the thread that is already here, or start a new one.
	 *
	 * The decision itself is `commentIntent`, which is where the reasoning and
	 * its tests live. This half resolves the anchors it needs and acts on the
	 * answer.
	 */
	private async showExistingOrCompose(
		view: EditorView,
		line: number,
		filePath: string,
		lastLine = line,
	): Promise<void> {
		const comments = await this.host.storage.getCommentsForFile(filePath);
		const threads = buildThreads(view.state.doc.toString(), comments, {
			fuzzy: true,
			threshold: this.host.settings().fuzzyThreshold,
		});

		const lineInfo = view.state.doc.line(line);
		// Open threads only. A resolved one is settled, and the editor shows no
		// sign of it — resolveMarkers skips resolved comments, so there is no
		// marker and no highlight. Letting it answer meant a line that looked
		// uncommented offered the "add a comment" affordance and then produced a
		// thread the reader could not see, with no way to comment those words
		// again (#113). A hole in #75, which made the selection decide but kept
		// handing over every thread.
		const anchored = threads
			.filter((thread) => !thread.root.resolved && thread.position !== null && thread.end !== null)
			.map((thread) => ({ id: thread.root.id, from: thread.position!, to: thread.end! }));
		const selection = view.state.selection.main;

		// The whole block the reader acted on: a rendered table's marker stands for
		// every row, so its threads have to be found on every row (#140).
		const block = { from: lineInfo.from, to: view.state.doc.line(lastLine).to };
		const intent = commentIntent(anchored, block, {
			from: selection.from,
			to: selection.to,
		});

		if (intent.kind === "compose") {
			this.compose(view, filePath, intent.from, intent.to);
			return;
		}

		const shown = intent.threadIds
			.map((id) => threads.find((candidate) => candidate.root.id === id))
			.filter((thread): thread is Thread => thread !== undefined);
		if (shown.length === 0) return;

		// With the panel on screen, selecting there keeps everything in one place.
		// Otherwise a popover beside the line beats yanking the reader's attention
		// across the window, or pulling a drawer over the note on a phone (#125).
		const panel = this.host.visiblePanel();
		if (panel) {
			await panel.select(shown[0].root.id);
			return;
		}

		this.host.openPopover(
			shown,
			filePath,
			this.lineRect(view, line),
			view.state.doc.toString(),
			view.dom.ownerDocument,
		);
		if (this.host.sheet()) this.keepAboveSheet(view, view.state.doc.line(line).from);
	}

	/**
	 * Scroll the note so a line sits near the top, clear of a bottom sheet.
	 *
	 * The sheet covers the lower half of the screen, which is exactly where a
	 * tapped line near the bottom would otherwise be left hidden under it (#135).
	 * The margin keeps the line below the floating buttons over a phone's note.
	 */
	private keepAboveSheet(view: EditorView, pos: number): void {
		view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 96 }) });
	}

	/** Screen rect of a line, for anchoring the popover. */
	private lineRect(view: EditorView, line: number): AnchorRect {
		const coords = view.coordsAtPos(view.state.doc.line(line).from);
		return coords
			? { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom }
			: { left: 0, right: 0, top: 0, bottom: 0 };
	}

	/**
	 * Open the composer over a span the caller has already decided on.
	 *
	 * The span is passed in rather than read from the selection here: this used
	 * to take whatever was selected anywhere in the note, so a selection on one
	 * line and a gutter click on another stored the comment against the
	 * selection (#81).
	 */
	private compose(view: EditorView, filePath: string, from: number, to: number): void {
		const coords = view.coordsAtPos(from);
		const anchorRect = coords
			? { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom }
			: { left: 0, right: 0, top: 0, bottom: 0 };

		this.composer?.close();
		this.composer = new FloatingComposer({
			anchorRect,
			sheet: this.host.sheet(),
			onSubmit: (content) => this.createComment(view, filePath, from, to, content),
			onCancel: () => {
				this.composer = null;
			},
		});
		// In the editor's own window: the note may be open in a popout (#236).
		this.composer.open(view.dom.ownerDocument.body);
		if (this.host.sheet()) this.keepAboveSheet(view, from);
	}

	private async createComment(
		view: EditorView,
		filePath: string,
		from: number,
		to: number,
		content: string,
	): Promise<boolean> {
		const now = Date.now();
		const comment: Comment = {
			id: crypto.randomUUID(),
			filePath,
			anchor: createAnchor(view.state.doc.toString(), from, to),
			content,
			author: this.host.settings().author,
			createdAt: now,
			updatedAt: now,
			resolved: false,
			parentId: null,
		};
		try {
			await this.host.storage.saveComment(comment);
		} catch (error) {
			// Said, and reported as not saved, so the composer keeps the text it
			// would otherwise have thrown away (#266).
			console.error("margin-comments: a comment could not be saved", error);
			new Notice(describeFailedSave(filePath, error));
			return false;
		}
		await this.host.refresh();
		return true;
	}
}
