import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Comment } from "../types";
import { buildThreads, type Thread } from "./threads";
import {
	THREAD_FILTERS,
	countThreads,
	emptyStateMessage,
	filterLabel,
	filterThreads,
	type ThreadFilter,
} from "./panel-filter";
import { renderThreadCard, type ThreadActions } from "./thread-card";

export const COMMENT_PANEL_VIEW = "inline-comments-panel";

export interface PanelHost extends ThreadActions {
	/** Comments for the active note, plus the note's text to anchor them against. */
	loadActive(): Promise<{ filePath: string; doc: string; comments: Comment[] } | null>;
	/** Scroll the editor to a thread's anchor. */
	revealThread(thread: Thread): void;
	/** Close the panel. */
	closePanel(): void;
	/** The filter chosen last, restored from plugin data on startup. */
	filter(): ThreadFilter;
	/** Persist a new filter choice. */
	setFilter(filter: ThreadFilter): Promise<void>;
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
		// Arriving from a marker beats the filter: pointing at a resolved thread
		// while the panel shows only open ones would answer with an empty list.
		if (!this.cards.has(rootId) && this.host.filter() !== "all") {
			await this.host.setFilter("all");
			await this.render();
		}
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
			this.renderHeaderControls(header, "");
			this.renderEmpty(container, "Open a note to see its comments.");
			return;
		}

		this.renderHeaderControls(header, active.filePath.replace(/\.md$/, "").split("/").pop() ?? "");

		const all = buildThreads(active.doc, active.comments);
		const filter = this.host.filter();
		this.renderFilters(container, all, filter);

		const threads = filterThreads(all, filter);
		if (threads.length === 0) {
			this.renderEmpty(container, emptyStateMessage(filter));
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

	private renderHeaderControls(header: HTMLElement, title: string): void {
		header.createSpan({ cls: "inline-comment-panel-title", text: title });
		// A close control on the panel itself: the ribbon icon toggles it, but a
		// panel with no visible way out reads as stuck.
		const close = header.createEl("button", {
			cls: "inline-comment-action",
			attr: { "aria-label": "Close comments panel", title: "Close comments panel" },
		});
		setIcon(close, "x");
		close.addEventListener("click", () => this.host.closePanel());
	}

	/**
	 * The filter bar, each segment carrying the count it would render.
	 *
	 * Counts come from the same thread list the cards do, so a segment can never
	 * promise results the filter does not produce.
	 */
	private renderFilters(container: HTMLElement, all: Thread[], selected: ThreadFilter): void {
		const counts = countThreads(all);
		const bar = container.createDiv({ cls: "inline-comment-filters", attr: { role: "group" } });

		for (const filter of THREAD_FILTERS) {
			const button = bar.createEl("button", {
				cls: `inline-comment-filter${filter === selected ? " is-active" : ""}`,
				attr: { "aria-pressed": String(filter === selected) },
			});
			button.createSpan({ text: filterLabel(filter) });
			button.createSpan({ cls: "inline-comment-filter-count", text: `${counts[filter]}` });
			button.addEventListener("click", () => {
				void (async () => {
					await this.host.setFilter(filter);
					await this.render();
				})();
			});
		}
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		// An empty state that says what to do next, so it never reads as broken.
		container.createDiv({ cls: "inline-comment-empty", text: message });
	}
}
