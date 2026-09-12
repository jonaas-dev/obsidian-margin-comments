import { App, Component } from "obsidian";
import { computePosition, type AnchorRect } from "../editor/floating-position";
import type { Thread } from "./threads";
import { renderThreadCard, type ThreadActions } from "./thread-card";

/**
 * A thread shown beside the line it belongs to.
 *
 * A popover rather than a modal: a comment separated from the text it is about
 * loses half its meaning, and a modal covers exactly that text. It is also the
 * pattern people already know from Google Docs and Figma.
 */
export class ThreadPopover extends Component {
	private el: HTMLElement | null = null;
	/** Lifecycle owner of the card currently on screen. See CommentPanelView. */
	private cardScope: Component | null = null;
	private onOutsideClick: ((event: MouseEvent) => void) | null = null;
	private onKeyDown: ((event: KeyboardEvent) => void) | null = null;

	constructor(
		private app: App,
		private actions: ThreadActions,
	) {
		super();
	}

	open(thread: Thread, filePath: string, anchorRect: AnchorRect, doc?: string): void {
		this.close();

		const el = document.body.createDiv({ cls: "inline-comment-popover" });
		this.el = el;
		this.cardScope = new Component();
		this.addChild(this.cardScope);
		renderThreadCard(el, thread, filePath, this.app, this.cardScope, this.actions, {
			alwaysOpen: true,
			onReplied: () => this.close(),
			doc,
		});

		this.position(anchorRect);

		// Deferred: the click that opened this is still propagating, and binding
		// synchronously would close it immediately.
		window.setTimeout(() => {
			this.onOutsideClick = (event: MouseEvent) => {
				if (this.el && !this.el.contains(event.target as Node)) this.close();
			};
			document.addEventListener("mousedown", this.onOutsideClick);
		}, 0);

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

	private position(anchorRect: AnchorRect): void {
		if (!this.el) return;
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
		this.el?.remove();
		this.el = null;
		if (this.cardScope) {
			this.removeChild(this.cardScope);
			this.cardScope = null;
		}
	}

	onunload(): void {
		this.close();
	}
}
