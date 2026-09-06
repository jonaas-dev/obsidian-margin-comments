import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Comment } from "../types";
import { buildThreads, type Thread } from "./threads";
import { renderThreadCard, type ThreadActions } from "./thread-card";

export const COMMENT_PANEL_VIEW = "inline-comments-panel";

export interface PanelHost extends ThreadActions {
	/** Comments for the active note, plus the note's text to anchor them against. */
	loadActive(): Promise<{ filePath: string; doc: string; comments: Comment[] } | null>;
	/** Scroll the editor to a thread's anchor. */
	revealThread(thread: Thread): void;
	/** Close the panel. */
	closePanel(): void;
}

export class CommentPanelView extends ItemView {
	/** Root id to highlight after the next render, set when arriving from a marker. */
	private pendingSelection: string | null = null;
	private cards = new Map<string, HTMLElement>();

	constructor(
		leaf: WorkspaceLeaf,
		private host: PanelHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return COMMENT_PANEL_VIEW;
	}

	getDisplayText(): string {
		return "Inline comments";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	/** Highlight a thread and scroll it into view, re-rendering first if needed. */
	async select(rootId: string): Promise<void> {
		this.pendingSelection = rootId;
		if (!this.cards.has(rootId)) await this.render();
		this.applySelection();
	}

	private applySelection(): void {
		for (const card of this.cards.values()) card.removeClass("is-selected");
		if (this.pendingSelection === null) return;

		const card = this.cards.get(this.pendingSelection);
		if (!card) return;
		card.addClass("is-selected");
		card.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}

	async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("inline-comment-panel");
		this.cards.clear();

		const active = await this.host.loadActive();
		const header = container.createDiv({ cls: "inline-comment-panel-header" });

		if (!active) {
			this.renderHeaderControls(header, "", 0);
			this.renderEmpty(container, "Open a note to see its comments.");
			return;
		}

		const threads = buildThreads(active.doc, active.comments);
		this.renderHeaderControls(
			header,
			active.filePath.replace(/\.md$/, "").split("/").pop() ?? "",
			threads.length,
		);

		if (threads.length === 0) {
			this.renderEmpty(container, "Hover the left edge of a line to add the first comment.");
			return;
		}

		const list = container.createDiv({ cls: "inline-comment-list" });
		for (const thread of threads) {
			const card = renderThreadCard(list, thread, active.filePath, this.app, this, this.host);
			this.cards.set(thread.root.id, card);
			if (!thread.orphaned) {
				card.addEventListener("click", () => this.host.revealThread(thread));
			}
		}

		this.applySelection();
	}

	private renderHeaderControls(header: HTMLElement, title: string, count: number): void {
		header.createSpan({ cls: "inline-comment-panel-title", text: title });
		if (count > 0) {
			header.createSpan({ cls: "inline-comment-panel-count", text: `${count}` });
		}
		// A close control on the panel itself: the ribbon icon toggles it, but a
		// panel with no visible way out reads as stuck.
		const close = header.createEl("button", {
			cls: "inline-comment-action",
			attr: { "aria-label": "Close comments panel", title: "Close comments panel" },
		});
		setIcon(close, "x");
		close.addEventListener("click", () => this.host.closePanel());
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		// An empty state that says what to do next, so it never reads as broken.
		container.createDiv({ cls: "inline-comment-empty", text: message });
	}
}
