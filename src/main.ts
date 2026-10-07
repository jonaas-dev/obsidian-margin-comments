import { MarkdownView, Notice, Platform, Plugin, TFile, type EventRef } from "obsidian";
import { listenInEveryWindow } from "./windows";
import { EditorView } from "@codemirror/view";
import {
	CommentNotFoundError,
	CommentStorage,
	describeFailedSave,
	describeInvalidComments,
	describeNewerFormat,
	describeUnreadableSidecar,
} from "./storage";
import { NoteEvents } from "./vault-events";
import { HIGHLIGHT_VARIABLE, highlightOverride } from "./appearance";
import { InlineCommentsSettingTab, type SettingsHost } from "./settings";
import {
	toAuthor,
	toFuzzyThreshold,
	toHighlightColor,
	toOrphanedBehavior,
	toPanelPosition,
} from "./settings-values";
import {
	commentGutter,
	updateCommentedLines,
	updateCountEnabled,
	updateGutterEnabled,
} from "./editor/hover-gutter";
import { resolveMarkers } from "./editor/marker-pass";
import { lineHighlights, updateHighlights } from "./editor/line-highlight";
import { ThreadRouting } from "./editor/thread-routing";
import type { Binding } from "./ui/hotkey";

/** Named once: the panel quotes it when no key is bound to it. */
const ADD_COMMENT_NAME = "Add comment to selection";
import { ReadingMode, type ReadingModeHost } from "./reading/reading-mode";
import { debounce, type Debounced } from "./debounce";
import {
	DEFAULT_SETTINGS,
	type Comment,
	type PanelScope,
	type PluginSettings,
	type SortOrder,
} from "./types";
import { COMMENT_PANEL_VIEW, CommentPanelView, type NoteData } from "./ui/comment-panel";
import { buildSections, toPanelScope, type VaultSection } from "./ui/vault-sections";
import { toThreadFilter, type ThreadFilter } from "./ui/panel-filter";
import { toSortOrder } from "./ui/panel-sort";
import { ThreadPopover } from "./ui/thread-popover";
import { buildThreads } from "./threads";
import { OrphanNotice, orphanCount } from "./ui/orphans";
import { createReply } from "./ui/replies";
import {
	describeDeletion,
	describeResolveAll,
	describeResolveAllFailures,
	openRoots,
	withEditedContent,
	withResolved,
} from "./ui/comment-actions";
import { ConfirmModal } from "./ui/confirm-modal";
import { Navigation } from "./navigation";
import { inBackground } from "./background";

/**
 * Stillness before a typing burst is redrawn.
 *
 * Long enough that a run of keystrokes costs one pass, short enough that the
 * markers are back before anyone looks away from the line they just edited.
 */
const REFRESH_DEBOUNCE_MS = 300;

export default class InlineCommentsPlugin extends Plugin implements SettingsHost {
	storage!: CommentStorage;
	settings: PluginSettings = DEFAULT_SETTINGS;
	private routing!: ThreadRouting;
	private navigation!: Navigation;
	private popover: ThreadPopover | null = null;
	/** Note the open popover belongs to, so a genuine note switch closes it. */
	private popoverFile: string | null = null;
	/** Owned by the plugin, not the panel: the panel is rebuilt on every close
	 *  and reopen, and the notice has to stay silent across both. */
	private readonly orphanNotice = new OrphanNotice();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.buildCore();
		this.registerPanel();
		this.buildReadingAndRouting();
		this.registerEditor();
		this.registerCommands();
		this.registerVaultEvents();

		// Last, because it paints: everything it reaches has to exist by now.
		this.app.workspace.onLayoutReady(() => {
			inBackground("refresh the markers and the panel", this.refresh());
			inBackground("check for orphaned comments", this.checkOrphans());
		});
	}

	/**
	 * Settings, as stored and then as trusted.
	 *
	 * `data.json` survives across versions and can be hand-edited, so every stored
	 * choice is validated rather than taken at its word.
	 */
	private async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as object) };
		// data.json survives across versions and can be hand-edited, so the stored
		// filter is validated rather than trusted.
		this.settings.panelFilter = toThreadFilter(this.settings.panelFilter);
		this.settings.sortOrder = toSortOrder(this.settings.sortOrder);
		this.settings.panelScope = toPanelScope(this.settings.panelScope);
		this.settings.author = toAuthor(this.settings.author, DEFAULT_SETTINGS.author);
		this.settings.fuzzyThreshold = toFuzzyThreshold(
			this.settings.fuzzyThreshold,
			DEFAULT_SETTINGS.fuzzyThreshold,
		);
		this.settings.highlightColor = toHighlightColor(
			this.settings.highlightColor,
			DEFAULT_SETTINGS.highlightColor,
		);
		this.settings.orphanedBehavior = toOrphanedBehavior(
			this.settings.orphanedBehavior,
			DEFAULT_SETTINGS.orphanedBehavior,
		);
		this.settings.panelPosition = toPanelPosition(
			this.settings.panelPosition,
			DEFAULT_SETTINGS.panelPosition,
		);
	}

	/**
	 * Storage, the popover and navigation.
	 *
	 * First, because everything registered below closes over them.
	 */
	private buildCore(): void {
		this.storage = new CommentStorage(this.app.vault.adapter, {
			onUnreadable: (filePath, keptAt) => {
				// No timeout: the path in the message is the only way back to those comments.
				new Notice(describeUnreadableSidecar(filePath, keptAt), 0);
			},
			onInvalid: (filePath, count, keptAt) => {
				new Notice(describeInvalidComments(filePath, count, keptAt), 0);
			},
			onNewerFormat: (filePath) => {
				new Notice(describeNewerFormat(filePath), 0);
			},
		});
		this.popover = new ThreadPopover(
			this.app,
			{
				addReply: (root, content) => this.addReply(root, content),
				editComment: (comment, content) => this.editComment(comment, content),
				setResolved: (root, resolved) => this.setResolved(root, resolved),
				deleteComment: (comment) => this.confirmDelete(comment),
			},
			() => this.sheet,
			() => this.touch,
		);
		this.addChild(this.popover);
		this.navigation = new Navigation({
			app: this.app,
			storage: this.storage,
			touch: () => this.touch,
			markdownViewFor: (path) => this.markdownViewFor(path),
		});
	}

	/**
	 * The comments panel, its settings tab, and the two ways to open it.
	 *
	 * The ribbon icon and the command do the same thing, which is why they sit
	 * together rather than filed by kind.
	 */
	private registerPanel(): void {
		this.registerView(
			COMMENT_PANEL_VIEW,
			(leaf) =>
				new CommentPanelView(leaf, {
					loadActive: () => this.loadActive(),
					revealThread: (thread) => this.navigation.revealThread(thread),
					addReply: (root, content) => this.addReply(root, content),
					editComment: (comment, content) => this.editComment(comment, content),
					setResolved: (root, resolved) => this.setResolved(root, resolved),
					deleteComment: (comment) => this.confirmDelete(comment),
					closePanel: () => this.app.workspace.detachLeavesOfType(COMMENT_PANEL_VIEW),
					filter: () => this.settings.panelFilter,
					setFilter: (filter) => this.setPanelFilter(filter),
					sortOrder: () => this.settings.sortOrder,
					setSortOrder: (order) => this.setSortOrder(order),
					fuzzyThreshold: () => this.settings.fuzzyThreshold,
					scope: () => this.settings.panelScope,
					setScope: (scope) => this.setPanelScope(scope),
					loadVault: () => this.loadVault(),
					countSetAside: () => this.storage.countSetAside(),
					loadNote: (filePath) => this.loadNote(filePath),
					openThreadInNote: (filePath, thread) =>
						inBackground(
							"open a thread in another note",
							this.navigation.openThreadInNote(filePath, thread),
						),
					notifyOrphans: (count) => this.announceOrphans(count),
					touch: () => this.touch,
					addCommentBinding: () => this.addCommentBinding(),
					addCommentName: () => ADD_COMMENT_NAME,
				}),
		);

		this.addSettingTab(new InlineCommentsSettingTab(this.app, this));

		this.addRibbonIcon(
			"message-square",
			"Toggle comments panel",
			() => void this.togglePanel(),
		);
		this.addCommand({
			id: "toggle-comments-panel",
			name: "Toggle comments panel",
			callback: () => void this.togglePanel(),
		});
	}

	/**
	 * Reading mode, and the routing that opens a thread from a marker.
	 *
	 * Together because opening the popover is the wiring they share, and because
	 * the highlight colour has to reach the stylesheet before either paints.
	 */
	private buildReadingAndRouting(): void {
		this.applyHighlightColour();
		const openPopover: ReadingModeHost["openPopover"] = (
			threads,
			filePath,
			rect,
			doc,
			owner,
		) => {
			this.popoverFile = filePath;
			this.popover?.open(threads, filePath, rect, doc, owner);
		};
		this.reading = new ReadingMode({
			app: this.app,
			storage: this.storage,
			settings: () => this.settings,
			visiblePanel: () => this.visiblePanel(),
			sheet: () => this.sheet,
			openPopover,
		});
		this.routing = new ThreadRouting({
			app: this.app,
			storage: this.storage,
			settings: () => this.settings,
			visiblePanel: () => this.visiblePanel(),
			sheet: () => this.sheet,
			openPopover,
			refresh: () => this.refresh(),
		});
	}

	/**
	 * Everything that hangs off an editor or a window.
	 *
	 * The click handler goes to every window and not only the ones opened from
	 * here on: a popout already open when the plugin loaded never got one, so
	 * its marks were painted and did nothing (#236, #265).
	 */
	private registerEditor(): void {
		this.registerMarkdownPostProcessor((el, ctx) => this.reading.markBlock(el, ctx));
		// In every window, not only the ones opened from here on: a popout that was
		// already open when the plugin loaded never got a listener, so its marks were
		// painted and did nothing (#236, #265).
		listenInEveryWindow(this, this.app.workspace, "click", (event: MouseEvent) => {
			inBackground("open a thread from reading mode", this.reading.openFrom(event));
		});
		this.registerEditorExtension(lineHighlights());
		this.registerEditorExtension(
			commentGutter({
				touch: () => this.touch,
				onActivate: (view, line, lastLine) => this.routing.open(view, line, lastLine),
			}),
		);
	}

	/**
	 * The commands that act on a note.
	 *
	 * Editor-scoped, so they grey out anywhere that is not one.
	 */
	private registerCommands(): void {
		this.addCommand({
			id: "add-comment",
			name: ADD_COMMENT_NAME,
			// No default binding: Obsidian's plugin guidelines ask for none, since a
			// default can collide with one the reader already uses. Until they bind
			// it, the panel's empty state names the command instead (#122).
			editorCallback: (_editor, ctx) => {
				const view = (ctx as MarkdownView).editor as unknown as { cm?: EditorView };
				if (view.cm)
					this.routing.open(
						view.cm,
						view.cm.state.doc.lineAt(view.cm.state.selection.main.head).number,
					);
			},
		});

		// Editor-scoped, so they grey out anywhere that is not a note.
		this.addCommand({
			id: "next-comment",
			name: "Go to next comment",
			editorCallback: (_editor, ctx) =>
				inBackground(
					"jump to the next comment",
					this.navigation.jumpToComment(ctx as MarkdownView, "next"),
				),
		});

		this.addCommand({
			id: "previous-comment",
			name: "Go to previous comment",
			editorCallback: (_editor, ctx) =>
				inBackground(
					"jump to the previous comment",
					this.navigation.jumpToComment(ctx as MarkdownView, "previous"),
				),
		});

		this.addCommand({
			id: "resolve-all-comments",
			name: "Resolve all comments in this note",
			editorCallback: (_editor, ctx) => this.confirmResolveAll(ctx as MarkdownView),
		});
	}

	/**
	 * Everything that reacts to the vault changing underneath.
	 *
	 * The workspace's events and the vault's both: a note can be renamed from the
	 * file explorer with nothing open, and the comments still have to follow.
	 */
	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				// A tap inside the panel activates the panel's own leaf, and nothing it
				// shows has changed. Rebuilt between touchend and the synthesized click,
				// it moved a section head under the finger (#158).
				if (leaf?.view instanceof CommentPanelView) return;
				// Not on every refresh: the click that opens the popover also stirs
				// the workspace, and closing there shut it the instant it appeared.
				const path = this.app.workspace.getActiveFile()?.path ?? null;
				if (path !== this.popoverFile) this.popover?.close();
				inBackground("refresh the markers and the panel", this.refresh());
				inBackground("check for orphaned comments", this.checkOrphans());
			}),
		);
		// Debounced, and this path only. Typing is the one caller that fires per
		// keystroke, and the pass it triggers is not cheap: with 200 comments on a
		// 10,000-line note the markers cost ~20 ms and the panel repaints every
		// card, running the fuzzy stage for anything the edit unanchored. Every
		// other caller — saving a comment, switching note, changing a setting — is
		// a single act and stays immediate, so nothing on screen lags behind a
		// click. See tests/unit/marker-pass.test.ts for the measured budget.
		this.registerEvent(this.app.workspace.on("editor-change", () => this.refreshSoon()));
		const notes = new NoteEvents({
			storage: this.storage,
			orphanedBehavior: () => this.settings.orphanedBehavior,
			refresh: () => this.refresh(),
			readNote: async (filePath) => {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				// cachedRead rather than read: this runs on a vault event, and the
				// cache is what every other reader of a note already sees.
				return file instanceof TFile ? this.app.vault.cachedRead(file) : null;
			},
			fuzzyThreshold: () => this.settings.fuzzyThreshold,
		});
		// vault.on rather than a workspace event: a note can be renamed from the
		// file explorer with nothing open, and the comments still have to follow.
		this.registerEvent(
			this.app.vault.on("rename", (file, from) => void notes.followRename(from, file.path)),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => void notes.followDelete(file)));
		this.registerEvent(this.app.vault.on("create", (file) => void notes.followCreate(file)));
		// Not in Obsidian's types. Measured on desktop 1.13.7, it fires for every change
		// under the storage dotfolder, a sync client's and this plugin's own writes alike;
		// changedOnDisk tells them apart, so only another device's comments redraw (#260).
		const rawEvents = this.app.vault as unknown as {
			on(name: "raw", callback: (path: string) => void): EventRef;
		};
		this.registerEvent(rawEvents.on("raw", (path) => void this.followStorageChange(path)));
	}

	onunload(): void {
		// Before anything else: a pending pass firing after teardown would reach
		// for an editor and a store this plugin no longer owns.
		this.refreshSoon.cancel();
		this.routing?.close();
		this.popover?.close();
		// The custom property is set on a document the plugin does not own, so
		// leaving it behind would keep tinting lines after the plugin is gone.
		document.body.style.removeProperty(HIGHLIGHT_VARIABLE);
	}

	/**
	 * Publish the chosen highlight colour to the stylesheet.
	 *
	 * A custom property rather than inline styles on each decoration: the
	 * decorations are rebuilt on every keystroke, and the colour is not a
	 * per-line fact. Removing it hands the line back to the theme accent, which
	 * is what the stylesheet falls back to.
	 */
	applyHighlightColour(): void {
		const override = highlightOverride(this.settings.highlightColor);
		if (override === null) document.body.style.removeProperty(HIGHLIGHT_VARIABLE);
		else document.body.style.setProperty(HIGHLIGHT_VARIABLE, override);
	}

	/** Persist the settings object as it now stands. Part of SettingsHost. */
	save(): Promise<void> {
		return this.saveData(this.settings);
	}

	/**
	 * Move an open panel to the configured side.
	 *
	 * Detach and reopen rather than nudge: a leaf belongs to the sidebar it was
	 * created in, and there is no supported way to hand it to the other one. A
	 * closed panel is left closed — opening one because a setting changed would
	 * be an odd thing for a dropdown to do.
	 */
	async movePanel(): Promise<void> {
		if (this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW).length === 0) return;
		this.app.workspace.detachLeavesOfType(COMMENT_PANEL_VIEW);
		await this.openPanel();
	}

	private async openPanel(): Promise<void> {
		const leaf =
			this.settings.panelPosition === "left"
				? this.app.workspace.getLeftLeaf(false)
				: this.app.workspace.getRightLeaf(false);
		await leaf?.setViewState({ type: COMMENT_PANEL_VIEW, active: true });
		// void: revealLeaf returns a promise and nothing here depends on it having
		// settled, but dropping it silently is how an unhandled rejection happens.
		if (leaf) inBackground("reveal the panel", this.app.workspace.revealLeaf(leaf));
	}

	private async togglePanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW);
		if (existing.length > 0) {
			this.app.workspace.detachLeavesOfType(COMMENT_PANEL_VIEW);
			return;
		}
		await this.openPanel();
	}

	/**
	 * The MarkdownView showing `path`, if one is open.
	 *
	 * getActiveViewOfType is not usable here: focusing the panel makes it the
	 * active view, so the note the panel is describing stops being "active" the
	 * instant anyone clicks the panel.
	 */
	/**
	 * Every open editor showing a note, not just the first one found.
	 *
	 * A note can be open in several panes — editing on the left, reading on the
	 * right is an ordinary layout — and each pane is its own CodeMirror instance
	 * with its own decorations. Answering with one of them left the others
	 * showing the note as though it carried no comments at all (#83).
	 */
	private markdownViewsFor(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) views.push(view);
		}
		return views;
	}

	/** Any one editor showing a note, for callers that only want its text. */
	private markdownViewFor(path: string): MarkdownView | null {
		return this.markdownViewsFor(path)[0] ?? null;
	}

	/**
	 * Move comments to wherever their note went.
	 *
	 * A folder rename arrives as several overlapping events — the folder, then
	 * every descendant — so the same note is handled more than once. That is
	 * safe because `moveComments` refuses a second move of a note it is already
	 * moving; nothing here needs to sequence the events itself.
	 *
	 * Renaming a note that carries no comments moves nothing and costs one
	 * index read.
	 */
	/**
	 * Look for lost anchors in the note just opened, once a session.
	 *
	 * Deliberately not wired to editor-change: this is the only path outside the
	 * panel that runs the fuzzy stage, and paying for it per keystroke is the
	 * cost that stage was bounded to avoid. Arriving at a note is both cheap
	 * enough and the moment the news is actually new.
	 *
	 * Skipped entirely once the announcement is spent, so the pass costs nothing
	 * for the rest of the session rather than running to be thrown away.
	 */
	private async checkOrphans(): Promise<void> {
		if (this.orphanNotice.spent) return;

		const active = await this.loadActive();
		if (!active) return;
		const threads = buildThreads(active.doc, active.comments, {
			fuzzy: true,
			threshold: this.settings.fuzzyThreshold,
		});
		this.announceOrphans(orphanCount(threads));
	}

	/** Say once that comments lost their anchor; the panel shows which. */
	private announceOrphans(count: number): void {
		const message = this.orphanNotice.take(count, this.visiblePanel() !== null);
		if (message !== null) new Notice(message);
	}

	private async setPanelFilter(filter: ThreadFilter): Promise<void> {
		this.settings.panelFilter = filter;
		await this.saveData(this.settings);
	}

	private async setPanelScope(scope: PanelScope): Promise<void> {
		this.settings.panelScope = scope;
		await this.saveData(this.settings);
	}

	private async setSortOrder(order: SortOrder): Promise<void> {
		this.settings.sortOrder = order;
		await this.saveData(this.settings);
	}

	private async addReply(root: Comment, content: string): Promise<boolean> {
		return this.attempt(root.filePath, () =>
			this.storage.saveComment(createReply(root, content, this.settings.author)),
		);
	}

	private async editComment(comment: Comment, content: string): Promise<boolean> {
		return this.changeComment(comment, (stored) => withEditedContent(stored, content));
	}

	private async setResolved(root: Comment, resolved: boolean): Promise<boolean> {
		return this.changeComment(root, (stored) => withResolved(stored, resolved));
	}

	/**
	 * Runs a write and says whether it landed, redrawing either way.
	 *
	 * Every caller used to fire the write off with `void` after already clearing
	 * its field, so a rejection became an unhandled rejection in the console: the
	 * typed text was gone and nothing on screen said so (#266). Returning the
	 * outcome lets the field keep what it holds until the write is known to have
	 * worked.
	 */
	private async attempt(filePath: string, write: () => Promise<void>): Promise<boolean> {
		let saved = true;
		try {
			await write();
		} catch (error) {
			saved = false;
			console.error("margin-comments: a comment could not be saved", error);
			new Notice(describeFailedSave(filePath, error));
		}
		// Even after a failure: the panel and the popover should show what is
		// stored, not the change that did not happen.
		await this.refresh();
		await this.refreshPopover();
		return saved;
	}

	/**
	 * Applies a change to the comment as stored, not to the copy a card or the popover
	 * drew. That copy can predate a change still being written, and saving it put the
	 * old state back: an edit committed by the press on Resolve was undone by the
	 * resolve that followed (#264).
	 */
	private async changeComment(
		comment: Comment,
		change: (stored: Comment) => Comment,
	): Promise<boolean> {
		return this.attempt(comment.filePath, () =>
			this.storage.updateComment(comment.filePath, comment.id, change),
		);
	}

	private confirmDelete(comment: Comment): void {
		inBackground(
			"ask whether to delete a comment",
			(async () => {
				const all = await this.storage.getCommentsForFile(comment.filePath);
				new ConfirmModal(this.app, describeDeletion(comment, all), async () => {
					await this.storage.deleteComment(comment.filePath, comment.id);
					await this.refresh();
					await this.refreshPopover();
				}).open();
			})(),
		);
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

	/** Every commented note, with the ones the vault no longer has marked. */
	private async loadVault(): Promise<VaultSection[]> {
		const summaries = await this.storage.getCommentSummaries();
		// getAbstractFileByPath is an in-memory lookup, so this stays free of I/O
		// even on a vault with hundreds of commented notes.
		return buildSections(
			summaries,
			(path) => this.app.vault.getAbstractFileByPath(path) !== null,
		);
	}

	/**
	 * One note's text and comments.
	 *
	 * A missing note yields empty text rather than nothing at all: every comment
	 * on it then reads as orphaned, which is exactly what it is, and it can still
	 * be read and deleted.
	 */
	private async loadNote(filePath: string): Promise<NoteData> {
		const comments = await this.storage.getCommentsForFile(filePath);
		const view = this.markdownViewFor(filePath);
		if (view) return { doc: view.editor.getValue(), comments };

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return { doc: "", comments };
		return { doc: await this.app.vault.cachedRead(file), comments };
	}

	/**
	 * Resolve every open thread in the note, after saying how many.
	 *
	 * Confirmed even though resolving is reversible: this is the one action here
	 * that touches comments the user is not looking at.
	 */
	private confirmResolveAll(view: MarkdownView): void {
		inBackground(
			"ask whether to resolve every comment in the note",
			(async () => {
				if (!view.file) return;
				const filePath = view.file.path;
				const open = openRoots(await this.storage.getCommentsForFile(filePath));
				if (open.length === 0) {
					new Notice("No open comments in this note.");
					return;
				}

				new ConfirmModal(
					this.app,
					describeResolveAll(open.length),
					async () => {
						// By id, onto each comment as stored: the roots were read before the
						// dialog, and writing those copies undid any change made meanwhile (#264).
						let failed = 0;
						for (const root of open) {
							try {
								await this.storage.updateComment(filePath, root.id, (stored) =>
									withResolved(stored, true),
								);
							} catch (error) {
								// One thread deleted since the dialog opened is not worth a
								// notice of its own, but a write that failed for any other
								// reason has to be said: the rest of the threads did resolve,
								// so silence would read as "all done" (#266).
								if (!(error instanceof CommentNotFoundError)) {
									failed += 1;
									console.error(
										"margin-comments: a comment could not be resolved",
										error,
									);
								}
							}
						}
						await this.refresh();
						if (failed > 0) new Notice(describeResolveAllFailures(failed, open.length));
					},
					{
						confirmLabel: "Resolve",
						note: "Every thread can be reopened afterwards.",
						destructive: false,
					},
				).open();
			})(),
		);
	}

	private async refreshPanel(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(COMMENT_PANEL_VIEW)) {
			// A deferred leaf has no panel view yet and builds a fresh one when it is
			// shown, so there is nothing to redraw. Casting it threw on every refresh
			// after a restart (#129).
			if (leaf.view instanceof CommentPanelView) await leaf.view.render();
		}
	}

	/**
	 * The panel, if it is loaded and actually on screen.
	 *
	 * A leaf existing is not the panel being visible: on a phone the sidebars are
	 * drawers that sit collapsed nearly all the time, and a leaf restored with the
	 * layout stays deferred until it is shown. Answering in either selected a card
	 * nobody could see (#125).
	 */
	private visiblePanel(): CommentPanelView | null {
		const workspace = this.app.workspace;
		for (const leaf of workspace.getLeavesOfType(COMMENT_PANEL_VIEW)) {
			if (!(leaf.view instanceof CommentPanelView)) continue;
			const root = leaf.getRoot();
			if (root === workspace.leftSplit && workspace.leftSplit.collapsed) continue;
			if (root === workspace.rightSplit && workspace.rightSplit.collapsed) continue;
			// A background tab in an open sidebar is not on screen either.
			if (!leaf.view.containerEl.isShown()) continue;
			return leaf.view;
		}
		return null;
	}

	/** Redraw the popover with what it was showing that is still open (#133). */
	private async refreshPopover(): Promise<void> {
		const shown = this.popover?.current();
		if (!shown) return;
		const view = this.markdownViewFor(shown.filePath);
		if (!view) {
			this.popover?.close();
			return;
		}
		const doc = view.editor.getValue();
		const comments = await this.storage.getCommentsForFile(shown.filePath);
		const threads = buildThreads(doc, comments, {
			fuzzy: true,
			threshold: this.settings.fuzzyThreshold,
		})
			.filter((thread) => shown.threadIds.includes(thread.root.id))
			.filter((thread) => !thread.root.resolved && !thread.orphaned)
			.sort(
				(a, b) => shown.threadIds.indexOf(a.root.id) - shown.threadIds.indexOf(b.root.id),
			);
		this.popover?.redraw(threads, doc);
	}

	private reading!: ReadingMode;

	/**
	 * Whether this is a touch device.
	 *
	 * Read once and held rather than consulted at each call site, so the whole
	 * plugin agrees and a test can flip it and re-render.
	 */
	touch = Platform.isMobile;

	/**
	 * Whether the composer and the popover open as a bottom sheet (#135).
	 *
	 * Phones only: a tablet has the width to put them beside the text, which is
	 * what keeps the commented words visible. Held here for the same reason as
	 * `touch`, so a test can switch it.
	 */
	sheet = Platform.isPhone;

	/**
	 * The binding in effect for the add-comment command, or null.
	 *
	 * The reader's own if they set one, the plugin's default otherwise, and null
	 * when they have cleared it — at which point the panel names the command
	 * instead of a key that would do nothing. The hotkey manager is not in
	 * Obsidian's published types, so this stays defensive.
	 */
	private addCommentBinding(): Binding | null {
		const manager = (
			this.app as unknown as {
				hotkeyManager?: {
					getHotkeys?(id: string): Binding[] | null;
					getDefaultHotkeys?(id: string): Binding[] | null;
				};
			}
		).hotkeyManager;
		if (!manager) return null;

		const id = `${this.manifest.id}:add-comment`;
		const custom = manager.getHotkeys?.(id);
		if (custom) return custom[0] ?? null;
		return manager.getDefaultHotkeys?.(id)?.[0] ?? null;
	}

	/** Redraw when comments another device wrote reach the storage folder (#260). */
	private async followStorageChange(path: string): Promise<void> {
		if (await this.storage.changedOnDisk(path)) this.refreshSoon();
	}

	/** Redraw once typing stops. See the editor-change registration. */
	private readonly refreshSoon: Debounced = debounce(
		() => void this.refresh(),
		REFRESH_DEBOUNCE_MS,
	);

	/** Redraw markers, highlights and the panel. Part of SettingsHost. */
	async refresh(): Promise<void> {
		this.reading.clear();
		await this.refreshMarkers();
		this.reading.rerender();
		await this.refreshPanel();
	}

	private async refreshMarkers(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		const panes = this.markdownViewsFor(file.path);
		if (panes.length === 0) return;

		const comments = await this.storage.getCommentsForFile(file.path);

		// One pass for both halves and for every pane: the gutter and the
		// highlights want the same anchor matches, resolving them separately paid
		// for every comment twice, and two panes of one note hold one text.
		// Matching is what the pass costs; dispatching is what each pane costs.
		const markers = resolveMarkers(panes[0].editor.getValue(), comments);

		for (const pane of panes) {
			// Obsidian exposes the CodeMirror view here but does not declare it,
			// and it is absent in the legacy editor, so this stays defensive.
			const view = (pane.editor as unknown as { cm?: EditorView }).cm;
			if (!view) continue;

			updateGutterEnabled(view, this.settings.showGutterIcons);
			updateCountEnabled(view, this.settings.showCommentCount);
			updateCommentedLines(view, markers.counts);
			updateHighlights(
				view,
				this.settings.showLineHighlights
					? { lines: markers.lines, ranges: markers.ranges }
					: { lines: [], ranges: [] },
			);
		}
	}
}
