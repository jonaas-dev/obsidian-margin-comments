import { computePosition, visibleViewport, type AnchorRect } from "./floating-position";
import { placeSheet, watchPlacement } from "./bottom-sheet";
import { keyIntent } from "../ui/key-intent";

export interface ComposerOptions {
	/** Screen rect of the text being commented on. */
	anchorRect: AnchorRect;
	/** Pre-filled body, for editing an existing comment. */
	initialValue?: string;
	placeholder?: string;
	submitLabel?: string;
	onSubmit: (content: string) => void | Promise<void>;
	onCancel?: () => void;
	/** Open as a bottom sheet rather than beside the text. For phones (#135). */
	sheet?: boolean;
}

/**
 * A composer anchored next to the commented text.
 *
 * Deliberately not a Modal: a modal steals the whole screen and hides the very
 * text being commented on, which is what the comment is about.
 */
export class FloatingComposer {
	private el: HTMLElement | null = null;
	private textarea: HTMLTextAreaElement | null = null;
	private onOutsideClick: ((event: MouseEvent) => void) | null = null;
	/** Where focus was when the composer opened, so dismissing can give it back. */
	private returnFocusTo: HTMLElement | null = null;
	private stopWatching: (() => void) | null = null;

	constructor(private options: ComposerOptions) {}

	open(container: HTMLElement = document.body): void {
		this.close();

		// Captured before anything is built: the composer steals focus a few
		// frames from now, and on dismiss the caret has to go back where the
		// reader left it rather than to the top of the document.
		const active = document.activeElement;
		this.returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;

		const el = container.createDiv({ cls: "inline-comment-composer" });
		this.el = el;

		const textarea = el.createEl("textarea", {
			cls: "inline-comment-composer-input",
			attr: {
				placeholder: this.options.placeholder ?? "Write a comment…",
				"aria-label": "Comment body",
			},
		});
		textarea.value = this.options.initialValue ?? "";
		this.textarea = textarea;

		const actions = el.createDiv({ cls: "inline-comment-composer-actions" });
		const cancel = actions.createEl("button", { text: "Cancel", cls: "inline-comment-btn" });
		const submit = actions.createEl("button", {
			text: this.options.submitLabel ?? "Comment",
			cls: "inline-comment-btn mod-cta",
		});

		cancel.addEventListener("click", () => this.cancel());
		submit.addEventListener("click", () => void this.submit());
		textarea.addEventListener("keydown", (event) => this.onKeyDown(event));

		this.position();

		// Both deferred to the next tick. The click that opened the composer is
		// still propagating, so binding the outside-click handler synchronously
		// would close it immediately; and Obsidian returns focus to the editor
		// after the gutter click settles, so focusing synchronously leaves the
		// textarea unfocused and every keystroke going to the note instead.
		window.setTimeout(() => {
			this.onOutsideClick = (event: MouseEvent) => {
				if (this.el && !this.el.contains(event.target as Node)) this.cancel();
			};
			document.addEventListener("mousedown", this.onOutsideClick);
		}, 0);

		// The keyboard opens after the composer does, so the first placement is
		// made against the whole screen and has to be redone once it is up.
		this.stopWatching = watchPlacement(() => this.position());

		this.focusWhenSettled(textarea);
	}

	/**
	 * Claim focus once Obsidian stops handing it back.
	 *
	 * Obsidian returns focus to the editor asynchronously after a gutter click,
	 * and it does not say when. A single focus() call — synchronous or on the
	 * next tick — is overwritten, leaving the composer open with the caret still
	 * in the note. Retrying across a few frames until it sticks is the only
	 * reliable option available.
	 */
	private focusWhenSettled(textarea: HTMLTextAreaElement, windowMs = 400): void {
		const deadline = Date.now() + windowMs;
		const claim = (): void => {
			// The composer may have been dismissed while we were waiting.
			if (this.el === null) return;
			if (document.activeElement !== textarea) textarea.focus();
			if (Date.now() < deadline) requestAnimationFrame(claim);
		};
		requestAnimationFrame(claim);
	}

	private position(): void {
		if (!this.el) return;
		if (this.options.sheet) {
			placeSheet(this.el);
			return;
		}
		const size = this.el.getBoundingClientRect();
		const { left, top, placement } = computePosition(
			this.options.anchorRect,
			{ width: size.width, height: size.height },
			visibleViewport(window),
		);
		this.el.style.left = `${left}px`;
		this.el.style.top = `${top}px`;
		this.el.dataset.placement = placement;
	}

	private onKeyDown(event: KeyboardEvent): void {
		const intent = keyIntent(event);
		if (intent === "ignore" || intent === "newline") return;
		event.preventDefault();
		if (intent === "cancel") this.cancel();
		else void this.submit();
	}

	private async submit(): Promise<void> {
		const content = this.textarea?.value.trim() ?? "";
		// An empty comment is a mis-click, not a comment.
		if (content === "") {
			this.cancel();
			return;
		}
		const submit = this.options.onSubmit(content);
		this.close();
		await submit;
	}

	private cancel(): void {
		this.close();
		this.options.onCancel?.();
	}

	close(): void {
		if (this.onOutsideClick) {
			document.removeEventListener("mousedown", this.onOutsideClick);
			this.onOutsideClick = null;
		}
		this.stopWatching?.();
		this.stopWatching = null;
		const wasOpen = this.el !== null;
		this.el?.remove();
		this.el = null;
		this.textarea = null;

		// Only when this call actually dismissed something: open() calls close()
		// first, and returning focus there would fight the focus it is about to
		// claim. isConnected because the element may have gone with a re-render.
		if (wasOpen && this.returnFocusTo?.isConnected) this.returnFocusTo.focus();
		this.returnFocusTo = null;
	}
}
