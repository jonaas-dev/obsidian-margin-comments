import { App, Component } from "obsidian";
import { computePosition, type AnchorRect } from "../editor/floating-position";
import { placeSheet } from "../editor/bottom-sheet";
import type { Thread } from "./threads";
import { renderThreadCard, type ThreadActions } from "./thread-card";

/** What the popover is showing, so its host can redraw it after an action. */
export interface PopoverContent {
	filePath: string;
	threadIds: string[];
}

/**
 * The threads on a line, shown beside it.
 *
 * A popover rather than a modal: a comment separated from the text it is about
 * loses half its meaning, and a modal covers exactly that text. It is also the
 * pattern people already know from Google Docs and Figma.
 */
export class ThreadPopover extends Component {
	private el: HTMLElement | null = null;
	/** Lifecycle owner of the cards currently on screen. See CommentPanelView. */
	private cardScope: Component | null = null;
	private onOutsideClick: ((event: MouseEvent) => void) | null = null;
	private onKeyDown: ((event: KeyboardEvent) => void) | null = null;
	private content: PopoverContent | null = null;
	private anchorRect: AnchorRect | null = null;
	private onViewportChange: (() => void) | null = null;

	/**
	 * `sheet` is read at each placement, like the plugin's `touch`, so a test can
	 * turn it on without rebuilding the popover.
	 */
	constructor(
		private app: App,
		private actions: ThreadActions,
		private sheet: () => boolean = () => false,
		private touch: () => boolean = () => false,
	) {
		super();
	}

	open(threads: Thread[], filePath: string, anchorRect: AnchorRect, doc?: string): void {
		this.close();
		if (threads.length === 0) return;

		this.el = document.body.createDiv({ cls: "inline-comment-popover" });
		this.anchorRect = anchorRect;
		this.renderCards(threads, filePath, doc);
		this.position(anchorRect);

		// Deferred: the click that opened this is still propagating, and binding
		// synchronously would close it immediately.
		window.setTimeout(() => {
			this.onOutsideClick = (event: MouseEvent) => {
				if (this.el && !this.el.contains(event.target as Node)) this.close();
			};
			document.addEventListener("mousedown", this.onOutsideClick);
		}, 0);

		// A reply field focused inside a sheet brings the keyboard up under it, and
		// only the visual viewport says so.
		const visual = window.visualViewport;
		if (visual) {
			this.onViewportChange = () => this.anchorRect && this.position(this.anchorRect);
			visual.addEventListener("resize", this.onViewportChange);
		}

		this.onKeyDown = (event: KeyboardEvent) => {
			// Only when focus is outside the card: inside, Escape belongs to
			// whichever field is open so it can cancel an edit without also
			// throwing away the popover.
			if (event.key === "Escape" && !this.el?.contains(document.activeElement)) {
				this.close();
			}
		};
		document.addEventListener("keydown", this.onKeyDown);
	}

	/** What is on screen, or null when the popover is closed. */
	current(): PopoverContent | null {
		return this.el ? this.content : null;
	}

	/**
	 * Show fresh threads in the popover already open, where it already is.
	 *
	 * An action taken from the popover changes what it shows: a resolved thread
	 * used to stay on screen exactly as it was, so nothing said the tap had worked
	 * and a second tap reopened it (#133). Closing on every action instead would
	 * drop the other threads of the line along with the one acted on (#137).
	 */
	redraw(threads: Thread[], doc?: string): void {
		if (!this.el || !this.content || !this.anchorRect) return;
		if (threads.length === 0) {
			this.close();
			return;
		}
		this.el.empty();
		this.renderCards(threads, this.content.filePath, doc);
		this.position(this.anchorRect);
	}

	private renderCards(threads: Thread[], filePath: string, doc?: string): void {
		if (!this.el) return;
		if (this.cardScope) this.removeChild(this.cardScope);
		this.cardScope = new Component();
		this.addChild(this.cardScope);
		this.content = { filePath, threadIds: threads.map((thread) => thread.root.id) };

		for (const thread of threads) {
			renderThreadCard(this.el, thread, filePath, this.app, this.cardScope, this.actions, {
				alwaysOpen: true,
				onReplied: () => this.close(),
				doc,
				touch: this.touch(),
			});
		}
	}

	private position(anchorRect: AnchorRect): void {
		if (!this.el) return;
		if (this.sheet()) {
			placeSheet(this.el);
			return;
		}
		const rect = this.el.getBoundingClientRect();
		const { left, top, placement } = computePosition(
			anchorRect,
			{ width: rect.width, height: rect.height },
			{ width: window.innerWidth, height: window.innerHeight },
		);
		this.el.style.left = `${left}px`;
		this.el.style.top = `${top}px`;
		this.el.dataset.placement = placement;
	}

	close(): void {
		if (this.onOutsideClick) {
			document.removeEventListener("mousedown", this.onOutsideClick);
			this.onOutsideClick = null;
		}
		if (this.onKeyDown) {
			document.removeEventListener("keydown", this.onKeyDown);
			this.onKeyDown = null;
		}
		if (this.onViewportChange) {
			window.visualViewport?.removeEventListener("resize", this.onViewportChange);
			this.onViewportChange = null;
		}
		this.el?.remove();
		this.el = null;
		this.content = null;
		this.anchorRect = null;
		if (this.cardScope) {
			this.removeChild(this.cardScope);
			this.cardScope = null;
		}
	}

	onunload(): void {
		this.close();
	}
}
