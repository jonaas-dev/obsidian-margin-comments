import { Component, ItemView, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import { listenInEveryWindow } from "../windows";
import { THREAD_FILTERS, type Comment, type PanelScope, type SortOrder, type ThreadFilter } from "../types";
import { buildThreads, type Thread } from "../threads";
import { countThreads, emptyStateMessage, filterLabel, filterThreads } from "./panel-filter";
import { SORT_ORDERS, sortLabel, sortThreads, toSortOrder } from "./panel-sort";
import { hotkeyHint, type Binding } from "./hotkey";
import {
	PANEL_SCOPES,
	countSections,
	filterSections,
	scopeLabel,
	toPanelScope,
	vaultEmptyStateMessage,
	type VaultSection,
} from "./vault-sections";
import { renderThreadCard, type CardDrafts, type ThreadActions } from "./thread-card";
import { orphanCount } from "./orphans";
import { inBackground } from "../background";

export const COMMENT_PANEL_VIEW = "margin-comments-panel";

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
	/** How many sidecars were set aside after a failure, and the folder holding them. */
	countSetAside(): Promise<{ count: number; folder: string }>;
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
	/**
	 * Whether this is a touch device. Injected rather than read from Platform
	 * here so a test can turn it on and watch the panel redraw for it.
	 */
	touch(): boolean;
	/**
	 * The binding in effect for "Add comment to selection", or null when the
	 * reader has cleared it. Injected for the same reason as `touch`.
	 */
	addCommentBinding(): Binding | null;
	/** The command's own name, for when there is no binding to name instead. */
	addCommentName(): string;
}

export class CommentPanelView extends ItemView {
	/** Root id to highlight after the next render, set when arriving from a marker. */
	private pendingSelection: string | null = null;
	private readonly cards = new Map<string, HTMLElement>();
	/** Last data loaded, so filter and sort can redraw without touching disk. */
	private active: { filePath: string; doc: string; comments: Comment[] } | null = null;
	/** Vault rows, straight from the index: paths and counts, no sidecars. */
	private sections: VaultSection[] = [];
	/** Sidecars set aside after a failure, read with the vault rows (#318). */
	private setAside: { count: number; folder: string } = { count: 0, folder: "" };
	/** Notes whose section is open. Deliberately not persisted — it is a reading
	 *  position, and restoring twenty open sections on startup would defeat the
	 *  laziness the view is built around. */
	private readonly expanded = new Set<string>();
	private readonly hydrated = new Map<string, NoteData>();
	/** The list the last paint drew, so repainting the same one keeps its place. */
	private paintedList: string | null = null;
	/** Drafts rescued from the cards being replaced, alive only across one repaint. */
	private drafts = new Map<string, CardDrafts>();
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
		private readonly host: PanelHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return COMMENT_PANEL_VIEW;
	}

	getDisplayText(): string {
		return "Margin comments";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		// The whole document, not the panel: clicking back into the note is the
		// commonest way to move on, and a panel-only listener never heard it
		// (#119). pointerdown precedes the marker's own click, so pressing another
		// marker clears first and selects after.
		//
		// And in every window: this had no popout counterpart at all, so a click in
		// one never cleared the selection (#265).
		listenInEveryWindow(this, this.app.workspace, "pointerdown", () => this.clearSelection());
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

	/**
	 * Forget where the reader arrived from.
	 *
	 * Selection answers "this is the thread you just clicked in the note", and
	 * that stops being true the moment they start reading the panel instead. It
	 * used to survive until the next repaint, so it went on pointing at a thread
	 * long after it meant anything (#102).
	 */
	private clearSelection(): void {
		if (this.pendingSelection === null) return;
		this.pendingSelection = null;
		for (const card of this.cards.values()) card.removeClass("is-selected");
	}

	async render(): Promise<void> {
		if (this.host.scope() === "vault") {
			this.setAside = await this.host.countSetAside();
			await this.loadVault();
		}
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

		// Copied before iterating: the body deletes from this set. See the note in
		// storage.ts on typescript:S7747.
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
		// A repaint of the same list is not a navigation. Typing in the note,
		// resolving a card and expanding a section all repaint, and emptying the
		// scroller sent the list back to its top each time (#162). A different note
		// or scope is a different list, and starts from the top.
		const shown = this.host.scope() === "vault" ? "vault" : `note:${this.active?.filePath ?? ""}`;
		const scrollTop = shown === this.paintedList ? container.scrollTop : 0;
		this.paintedList = shown;
		// Taken before the scroller is emptied and handed back during the repaint,
		// the way the scroll position already was. Keyed by id rather than by
		// position, so a card that moved or a list that was filtered still gets its
		// own text back — and a draft whose card is gone is simply dropped (#267).
		this.drafts = this.harvestDrafts();
		this.paintContent(container);
		this.drafts.clear();
		container.scrollTop = scrollTop;
		// And again once the bodies have landed. A card is drawn before its body is
		// rendered — more so since #263 moved rendering into a document of its own —
		// so the heights that decide where scrollTop lands are not final yet, and
		// restoring only once left the list 42 px from where it was (#162).
		if (scrollTop > 0) {
			const win = container.ownerDocument.defaultView ?? window;
			win.setTimeout(() => {
				win.setTimeout(() => {
					// Only while the list is still the one that was measured: a
					// navigation in between starts from the top on purpose.
					if (this.paintedList === shown) container.scrollTop = scrollTop;
				}, 0);
			}, 0);
		}
	}

	/**
	 * Half-written text in the cards about to be destroyed, by thread root id.
	 *
	 * The reply field keeps its draft on blur on purpose (#136), but the panel
	 * empties its scroller on every repaint, and a repaint arrives whenever the
	 * active leaf changes, 300 ms after a keystroke in the note, and after every
	 * comment write. Clicking back into the note was enough to lose a reply.
	 */
	private harvestDrafts(): Map<string, CardDrafts> {
		const drafts = new Map<string, CardDrafts>();
		const forRoot = (id: string): CardDrafts => {
			const existing = drafts.get(id);
			if (existing) return existing;
			const made: CardDrafts = {};
			drafts.set(id, made);
			return made;
		};

		for (const [rootId, card] of this.cards) {
			const reply = card.querySelector<HTMLTextAreaElement>(".inline-comment-replybox-input");
			// Only text worth keeping: an untouched field is not a draft, and
			// restoring one would stand every box open after a repaint.
			//
			// A disabled field is mid-write (#266), and this repaint is the one that
			// write asked for. Its own callback clears or re-enables it, so taking a
			// copy here would put a reply back after it had been sent.
			if (reply && !reply.disabled && reply.value.trim() !== "") {
				forRoot(rootId).reply = reply.value;
			}

			const open = Array.from(
				card.querySelectorAll<HTMLTextAreaElement>(".inline-comment-editor-input"),
			);
			if (open.length === 0) continue;
			const edits = new Map<string, string>();
			for (const box of open) {
				const id = box.dataset.commentId;
				if (id !== undefined && !box.disabled) edits.set(id, box.value);
			}
			if (edits.size > 0) forRoot(rootId).edits = edits;
		}
		return drafts;
	}

	private paintContent(container: HTMLElement): void {
		container.empty();
		container.addClass("inline-comment-panel");
		// Every touch-sized rule hangs off this, so it is one class to set and
		// one place to look when a control is too small to hit.
		container.toggleClass("is-touch", this.host.touch());
		// A landmark, so the panel can be jumped to rather than tabbed into from
		// wherever the reader happens to be.
		container.setAttribute("role", "complementary");
		container.setAttribute("aria-label", "Margin comments");
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
			// The hint only where it helps: a note with nothing in it yet. Saying
			// how to add a comment under "no resolved comments" answers a
			// question nobody asked, and a permanent hint would tax every reader
			// forever to teach one thing once.
			this.renderEmpty(
				container,
				emptyStateMessage(filter, this.host.touch()),
				all.length === 0
					? hotkeyHint(this.host.addCommentBinding(), Platform.isMacOS, this.host.addCommentName())
					: null,
			);
			return;
		}

		const list = container.createDiv({ cls: "inline-comment-list", attr: { role: "list" } });
		for (const thread of threads) {
			const card = this.renderCard(list, thread, active.filePath, active.doc, () =>
				this.host.revealThread(thread),
			);
			card.setAttribute("role", "listitem");
		}

		this.applySelection();
	}

	/** One collapsed row per commented note, expanded on demand. */
	private paintVault(container: HTMLElement): void {
		const filter = this.host.filter();
		this.renderFilters(container, countSections(this.sections), filter);

		this.renderSetAside(container);

		const sections = filterSections(this.sections, filter);
		if (sections.length === 0) {
			this.renderEmpty(container, vaultEmptyStateMessage(filter));
			return;
		}

		const list = container.createDiv({ cls: "inline-comment-list", attr: { role: "list" } });
		for (const section of sections) this.renderSection(list, section, filter);

		this.applySelection();
	}

	private renderSection(list: HTMLElement, section: VaultSection, filter: ThreadFilter): void {
		const expanded = this.expanded.has(section.filePath);
		// role=listitem because the container is a role=list: a list whose children
		// are plain divs is announced with no items at all, however many notes it
		// holds. The note-scope list above gets this right, which is what made it
		// look like an oversight rather than a decision (#318).
		const wrapper = list.createDiv({
			cls: `inline-comment-section${section.missing ? " is-missing" : ""}`,
			attr: { role: "listitem" },
		});

		const head = wrapper.createEl("button", {
			cls: "inline-comment-section-head",
			attr: { "aria-expanded": String(expanded) },
		});
		const chevron = head.createSpan({ cls: "inline-comment-section-chevron" });
		setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
		// The text in its own isolated run: the box is right-to-left so a long path
		// is cut at its start, and without isolation that same direction reorders
		// leading digits and brackets — "01 Long note.md" drew as "Long note.md 01" (#130).
		head
			.createSpan({ cls: "inline-comment-section-path" })
			.createSpan({ cls: "inline-comment-section-path-text", text: section.filePath });
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
			this.renderCard(body, thread, section.filePath, data.doc, () =>
				this.host.openThreadInNote(section.filePath, thread),
			);
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

	/**
	 * Drop the previous paint's child components before drawing the next.
	 *
	 * `removeChild` here is Obsidian's Component method, which unloads the child —
	 * not the DOM one. typescript:S7762 reads it as DOM and asks for
	 * `cardScope.remove()`, which would unload nothing and leak a component per
	 * repaint; markdown-cards.test.ts counts exactly that.
	 */
	private resetCardScope(): void {
		if (this.cardScope) this.removeChild(this.cardScope);
		this.cardScope = new Component();
		this.addChild(this.cardScope);
	}

	private renderCard(
		parent: HTMLElement,
		thread: Thread,
		filePath: string,
		doc: string,
		reveal: () => void,
	): HTMLElement {
		// One destination for the quote and the card. The quote keeps its click
		// from reaching the card, so a quote wired to the active note sent a card
		// in another note's section to the wrong note (#155).
		const card = renderThreadCard(parent, thread, filePath, this.app, this.cardScope, this.host, {
			onReveal: reveal,
			doc,
			touch: this.host.touch(),
			drafts: this.drafts.get(thread.root.id),
		});
		if (!thread.orphaned) card.addEventListener("click", reveal);
		// Reaching a different card is the reader turning their attention to the
		// panel, which is exactly when the arrival marker has served its purpose.
		card.addEventListener("mouseenter", () => {
			if (thread.root.id !== this.pendingSelection) this.clearSelection();
		});
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
			inBackground(
				"change the panel scope",
				(async () => {
				await this.host.setScope(toPanelScope(scope.value));
				await this.render();
				})(),
			);
		});

		if (selected === "note") {
			header.createSpan({ cls: "inline-comment-panel-title", text: title });
		}

		// A close control on the panel itself: the ribbon icon toggles it, but a
		// panel with no visible way out reads as stuck.
		const close = header.createEl("button", {
			cls: "clickable-icon inline-comment-action",
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
		// Filter and sort share a wrapper so a panel with the width can put them on
		// one row (#139); a narrow one still stacks them, which #72 measured.
		const controls = container.createDiv({ cls: "inline-comment-controls" });
		const bar = controls.createDiv({ cls: "inline-comment-filters", attr: { role: "group" } });

		for (const filter of THREAD_FILTERS) {
			const button = bar.createEl("button", {
				cls: `inline-comment-filter${filter === selected ? " is-active" : ""}`,
				attr: { "aria-pressed": String(filter === selected) },
			});
			button.createSpan({ text: filterLabel(filter) });
			button.createSpan({ cls: "inline-comment-filter-count", text: `${counts[filter]}` });
			button.addEventListener("click", () => {
				inBackground(
					"change the panel filter",
					(async () => {
					await this.host.setFilter(filter);
					this.paint();
					})(),
				);
			});
		}

		this.renderSortControl(controls);
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
			inBackground(
				"change the sort order",
				(async () => {
				await this.host.setSortOrder(toSortOrder(select.value));
				this.paint();
				})(),
			);
		});
	}

	/**
	 * Say that some sidecars were set aside, when any were.
	 *
	 * They are kept rather than deleted, which is right, and then never mentioned
	 * again, which is not: on a vault with a noisy sync they accumulate inside a
	 * hidden folder nobody opens (#318). Shown in the all-notes view because that
	 * is the one place about the vault rather than about a note, and it names the
	 * folder because finding it is the whole point.
	 */
	private renderSetAside(container: HTMLElement): void {
		if (this.setAside.count === 0) return;
		const one = this.setAside.count === 1;
		container.createDiv({
			cls: "inline-comment-set-aside",
			text: `${this.setAside.count} sidecar file${one ? "" : "s"} ${one ? "was" : "were"} set aside after a failure and ${one ? "is" : "are"} kept in ${this.setAside.folder}.`,
		});
	}

	private renderEmpty(container: HTMLElement, message: string, hint: string | null = null): void {
		// An empty state that says what to do next, so it never reads as broken.
		const empty = container.createDiv({ cls: "inline-comment-empty" });
		empty.createDiv({ text: message });
		if (hint) empty.createDiv({ cls: "inline-comment-empty-hint", text: hint });
	}
}

/** What the row's badge promises: the threads this filter would show. */
function sectionCount(section: VaultSection, filter: ThreadFilter): number {
	if (filter === "open") return section.open;
	if (filter === "resolved") return section.threads - section.open;
	return section.threads;
}
