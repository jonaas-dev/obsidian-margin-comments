import { Component, ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Comment, PanelScope, SortOrder } from "../types";
import { buildThreads, type Thread } from "./threads";
import {
	THREAD_FILTERS,
	countThreads,
	emptyStateMessage,
	filterLabel,
	filterThreads,
	type ThreadFilter,
} from "./panel-filter";
import { SORT_ORDERS, sortLabel, sortThreads, toSortOrder } from "./panel-sort";
import {
	PANEL_SCOPES,
	countSections,
	filterSections,
	scopeLabel,
	toPanelScope,
	vaultEmptyStateMessage,
	type VaultSection,
} from "./vault-sections";
import { renderThreadCard, type ThreadActions } from "./thread-card";
import { orphanCount } from "./orphans";

export const COMMENT_PANEL_VIEW = "inline-comments-panel";

/** A note's text and comments, as the panel needs them. */
export interface NoteData {
	doc: string;
	comments: Comment[];
}

export interface PanelHost extends ThreadActions {
	/** Comments for the active note, plus the note's text to anchor them against. */
	loadActive(): Promise<{ filePath: string; doc: string; comments: Comment[] } | null>;
	/** Every commented note in the vault, counts included, from the index alone. */
	loadVault(): Promise<VaultSection[]>;
	/** One note's text and comments, read when its section is opened. */
	loadNote(filePath: string): Promise<NoteData>;
	/** Scroll the editor to a thread's anchor. */
	revealThread(thread: Thread): void;
	/** Open another note and scroll to a thread in it. */
	openThreadInNote(filePath: string, thread: Thread): void;
	/** Close the panel. */
	closePanel(): void;
	/** The filter chosen last, restored from plugin data on startup. */
	filter(): ThreadFilter;
	/** Persist a new filter choice. */
	setFilter(filter: ThreadFilter): Promise<void>;
	/** The sort order chosen last, restored from plugin data on startup. */
	sortOrder(): SortOrder;
	/** Persist a new sort order. */
	setSortOrder(order: SortOrder): Promise<void>;
	/** Tolerance for the fuzzy re-anchoring stage, from the settings. */
	fuzzyThreshold(): number;
	/** Whether the panel is showing this note or the whole vault. */
	scope(): PanelScope;
	/** Persist a new scope. */
	setScope(scope: PanelScope): Promise<void>;
	/** Report how many threads the panel just drew as orphaned. */
	notifyOrphans(count: number): void;
}

export class CommentPanelView extends ItemView {
	/** Root id to highlight after the next render, set when arriving from a marker. */
	private pendingSelection: string | null = null;
	private cards = new Map<string, HTMLElement>();
	/** Last data loaded, so filter and sort can redraw without touching disk. */
	private active: { filePath: string; doc: string; comments: Comment[] } | null = null;
	/** Vault rows, straight from the index: paths and counts, no sidecars. */
	private sections: VaultSection[] = [];
	/** Notes whose section is open. Deliberately not persisted — it is a reading
	 *  position, and restoring twenty open sections on startup would defeat the
	 *  laziness the view is built around. */
	private expanded = new Set<string>();
	private hydrated = new Map<string, NoteData>();
	/**
	 * Lifecycle owner of the cards drawn by the current paint.
	 *
	 * Not the view itself: MarkdownRenderer registers a child component per
	 * embed, and the view outlives every repaint. Filter, sort, scope and
	 * settings changes all repaint, so hanging them off the view leaves one
	 * dead component per embed per repaint, alive until the panel is closed.
	 * A scope that is replaced with the DOM it belongs to cannot drift from it.
	 */
	private cardScope!: Component;

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

		// Arriving from a marker beats the controls: pointing at a thread the
		// panel is filtered or scoped away from would answer with an empty list.
		if (!this.cards.has(rootId) && this.host.scope() !== "note") {
			await this.host.setScope("note");
			await this.render();
		}
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
		if (this.host.scope() === "vault") await this.loadVault();
		else this.active = await this.host.loadActive();
		this.paint();
	}

	/**
	 * Vault rows, plus a re-read of whatever sections are open.
	 *
	 * Only the open ones: reading every sidecar here is exactly what the index
	 * counts exist to avoid. Re-reading them is not optional either — a refresh
	 * after an edit would otherwise redraw stale cards.
	 */
	private async loadVault(): Promise<void> {
		this.sections = await this.host.loadVault();
		const present = new Set(this.sections.map((section) => section.filePath));

		for (const filePath of [...this.expanded]) {
			if (!present.has(filePath)) {
				this.expanded.delete(filePath);
				this.hydrated.delete(filePath);
				continue;
			}
			this.hydrated.set(filePath, await this.host.loadNote(filePath));
		}
	}

	/**
	 * Draw from data already in hand.
	 *
	 * Filter and sort are view decisions: going back to the vault for them would
	 * turn every click on a control into an I/O round trip, and the answer would
	 * be the bytes just read.
	 */
	private paint(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("inline-comment-panel");
		this.cards.clear();
		this.resetCardScope();

		const header = container.createDiv({ cls: "inline-comment-panel-header" });
		if (this.host.scope() === "vault") {
			this.renderHeaderControls(header, "");
			this.paintVault(container);
			return;
		}

		const active = this.active;
		if (!active) {
			this.renderHeaderControls(header, "");
			this.renderEmpty(container, "Open a note to see its comments.");
			return;
		}

		this.renderHeaderControls(header, active.filePath.replace(/\.md$/, "").split("/").pop() ?? "");

		const all = sortThreads(this.threadsOf(active), this.host.sortOrder());
		const filter = this.host.filter();
		this.renderFilters(container, countThreads(all), filter);

		const threads = filterThreads(all, filter);
		if (threads.length === 0) {
			this.renderEmpty(container, emptyStateMessage(filter));
			return;
		}

		const list = container.createDiv({ cls: "inline-comment-list" });
		for (const thread of threads) {
			const card = this.renderCard(list, thread, active.filePath);
			if (!thread.orphaned) {
				card.addEventListener("click", () => this.host.revealThread(thread));
			}
		}

		this.applySelection();
	}

	/** One collapsed row per commented note, expanded on demand. */
	private paintVault(container: HTMLElement): void {
		const filter = this.host.filter();
		this.renderFilters(container, countSections(this.sections), filter);

		const sections = filterSections(this.sections, filter);
		if (sections.length === 0) {
			this.renderEmpty(container, vaultEmptyStateMessage(filter));
			return;
		}

		const list = container.createDiv({ cls: "inline-comment-list" });
		for (const section of sections) this.renderSection(list, section, filter);

		this.applySelection();
	}

	private renderSection(list: HTMLElement, section: VaultSection, filter: ThreadFilter): void {
		const expanded = this.expanded.has(section.filePath);
		const wrapper = list.createDiv({
			cls: `inline-comment-section${section.missing ? " is-missing" : ""}`,
		});

		const head = wrapper.createEl("button", {
			cls: "inline-comment-section-head",
			attr: { "aria-expanded": String(expanded) },
		});
		const chevron = head.createSpan({ cls: "inline-comment-section-chevron" });
		setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
		head.createSpan({ cls: "inline-comment-section-path", text: section.filePath });
		if (section.missing) {
			// Named rather than hidden: the note was renamed or deleted, and its
			// comments are still here to be read or cleaned up.
			head.createSpan({ cls: "inline-comment-section-missing", text: "not found" });
		}
		head.createSpan({
			cls: "inline-comment-filter-count",
			text: `${sectionCount(section, filter)}`,
		});

		head.addEventListener("click", () => void this.toggleSection(section.filePath));
		if (!expanded) return;

		const data = this.hydrated.get(section.filePath);
		if (!data) return;

		const threads = filterThreads(
			sortThreads(this.threadsOf(data), this.host.sortOrder()),
			filter,
		);
		const body = wrapper.createDiv({ cls: "inline-comment-section-body" });
		for (const thread of threads) {
			const card = this.renderCard(body, thread, section.filePath);
			if (!thread.orphaned) {
				card.addEventListener("click", () => this.host.openThreadInNote(section.filePath, thread));
			}
		}
	}

	private async toggleSection(filePath: string): Promise<void> {
		if (this.expanded.delete(filePath)) {
			this.hydrated.delete(filePath);
		} else {
			this.expanded.add(filePath);
			this.hydrated.set(filePath, await this.host.loadNote(filePath));
		}
		this.paint();
	}

	/**
	 * Threads for one note, with the fuzzy stage enabled.
	 *
	 * The panel redraws on note switches and edits, not on every keystroke, so it
	 * is the one place that can afford to look this hard before calling a comment
	 * orphaned.
	 */
	private threadsOf(note: { doc: string; comments: Comment[] }): Thread[] {
		const threads = buildThreads(note.doc, note.comments, {
			fuzzy: true,
			threshold: this.host.fuzzyThreshold(),
		});
		// Reported from here rather than from paint: this is the one place the
		// panel decides a comment is orphaned, and it covers the active note and
		// every expanded section without either path having to remember to ask.
		this.host.notifyOrphans(orphanCount(threads));
		return threads;
	}

	/** Drop the previous paint's child components before drawing the next. */
	private resetCardScope(): void {
		if (this.cardScope) this.removeChild(this.cardScope);
		this.cardScope = new Component();
		this.addChild(this.cardScope);
	}

	private renderCard(parent: HTMLElement, thread: Thread, filePath: string): HTMLElement {
		const card = renderThreadCard(parent, thread, filePath, this.app, this.cardScope, this.host);
		this.cards.set(thread.root.id, card);
		return card;
	}

	private renderHeaderControls(header: HTMLElement, title: string): void {
		const selected = this.host.scope();
		const scope = header.createEl("select", {
			cls: "dropdown inline-comment-scope",
			attr: { "aria-label": "Comment scope" },
		});
		for (const option of PANEL_SCOPES) {
			const el = scope.createEl("option", { text: scopeLabel(option), value: option });
			el.selected = option === selected;
		}
		// render, not paint: the two scopes read from different places.
		scope.addEventListener("change", () => {
			void (async () => {
				await this.host.setScope(toPanelScope(scope.value));
				await this.render();
			})();
		});

		if (selected === "note") {
			header.createSpan({ cls: "inline-comment-panel-title", text: title });
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

	/**
	 * The filter bar, each segment carrying the count it would render.
	 *
	 * Counts come from the same data the rows do — threads in this note, or
	 * threads across the vault — so a segment can never promise results the
	 * filter does not produce.
	 */
	private renderFilters(
		container: HTMLElement,
		counts: Record<ThreadFilter, number>,
		selected: ThreadFilter,
	): void {
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
					this.paint();
				})();
			});
		}

		this.renderSortControl(container);
	}

	/**
	 * Sort as a native dropdown, on its own row below the filter bar.
	 *
	 * A dropdown rather than three more segments: sort is changed rarely, and a
	 * second row of buttons would read as one long undifferentiated bank of
	 * controls above a short list. Native rather than Obsidian's Menu, which
	 * builds its DOM but never attaches it here — a control that cannot be
	 * proved to open is not a control.
	 *
	 * Its own row because there is never width for a fourth item beside three
	 * filter segments: measured, the header fits it only by crushing the note
	 * title from 167px to 24px at a 240px panel, and the filter bar fits it only
	 * by truncating "Resolved". A row that wraps reads as overflow, so the row
	 * is declared and the control fills it — which also makes it a touch target.
	 *
	 * In the vault view it orders threads inside a note; the notes themselves
	 * stay in path order, which is what makes the list scannable.
	 */
	private renderSortControl(container: HTMLElement): void {
		const selected = this.host.sortOrder();
		const row = container.createDiv({ cls: "inline-comment-sortbar" });
		const select = row.createEl("select", {
			cls: "dropdown inline-comment-sort",
			attr: { "aria-label": "Sort comments" },
		});

		for (const order of SORT_ORDERS) {
			const option = select.createEl("option", { text: sortLabel(order), value: order });
			option.selected = order === selected;
		}

		select.addEventListener("change", () => {
			void (async () => {
				await this.host.setSortOrder(toSortOrder(select.value));
				this.paint();
			})();
		});
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		// An empty state that says what to do next, so it never reads as broken.
		container.createDiv({ cls: "inline-comment-empty", text: message });
	}
}

/** What the row's badge promises: the threads this filter would show. */
function sectionCount(section: VaultSection, filter: ThreadFilter): number {
	if (filter === "open") return section.open;
	if (filter === "resolved") return section.threads - section.open;
	return section.threads;
}
