import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import type { Comment } from "../types";
import { formatRelativeTime, type Thread } from "./threads";
import { orphanExplanation } from "./orphans";
import { wasEdited } from "./comment-actions";
import { keyIntent } from "./key-intent";
import { emptyLineLabel } from "./labels";
import { shouldClamp } from "./clamp";

export interface ThreadActions {
	/** Store a reply to the given thread root. */
	addReply(root: Comment, content: string): Promise<void>;
	/** Persist an edited body. */
	editComment(comment: Comment, content: string): Promise<void>;
	/** Resolve or reopen a thread root. */
	setResolved(root: Comment, resolved: boolean): Promise<void>;
	/** Confirm, then delete the comment and any replies it owns. */
	deleteComment(comment: Comment): void;
}

export interface CardOptions {
	/** Reveal actions and the reply field without hovering. Used by the popover,
	 *  which is already a deliberate act — hiding its controls would be coy. */
	alwaysOpen?: boolean;
	/** Called after a reply is sent, so a popover can close itself. */
	onReplied?: () => void;
	/**
	 * Jump to the thread in the note.
	 *
	 * Given, the quote becomes a button: the card navigates on click, and a
	 * click handler on a plain div is reachable by mouse and by nothing else.
	 * The popover leaves this out — it is already anchored to the line it would
	 * take you to.
	 */
	onReveal?: () => void;
	/**
	 * The note as it stands, so the quote can show what the comment points at
	 * rather than what it was made on.
	 *
	 * Without it the card quoted the stored anchor forever: a comment on an
	 * empty line still said "Empty line" after the line was written on, and one
	 * that moved through the fuzzy stage still quoted the words it used to sit
	 * on (#115). #34 settled this for reading mode already — the document as it
	 * stands is what the reader will find when they jump there.
	 */
	doc?: string;
	/**
	 * A touch device, where nothing hovers. The reply field folds behind a Reply
	 * button there instead of standing open under every card, which left about
	 * three cards to a phone screen (#136).
	 */
	touch?: boolean;
}

const SHOW_MORE = "Show more";
const SHOW_LESS = "Show less";

interface IconButtonOptions {
	icon: string;
	label: string;
	onClick: () => void;
	extraClass?: string;
}

/**
 * An icon-only action.
 *
 * Obsidian's own icon set rather than text or emoji, so the card reads as part
 * of the app. The label is not decorative: with no visible text it is the only
 * thing a screen reader or a tooltip has to go on.
 */
function iconButton(parent: HTMLElement, options: IconButtonOptions): HTMLElement {
	// clickable-icon is Obsidian's own class for icon buttons, and its form-button
	// rule `button:not(.clickable-icon)` excludes it on purpose. Without it that
	// rule wins on specificity (0,1,1 against a lone class) and paints every icon
	// with a filled chip and no hover response — measured, the pencil's colour and
	// background were identical with the pointer on it and off it (#96).
	const button = parent.createEl("button", {
		cls: `clickable-icon inline-comment-action${options.extraClass ? ` ${options.extraClass}` : ""}`,
		attr: { "aria-label": options.label, title: options.label },
	});
	setIcon(button, options.icon);
	button.addEventListener("click", (event) => {
		// Every action sits inside a card that navigates on click.
		event.stopPropagation();
		options.onClick();
	});
	return button;
}

interface TextButtonOptions {
	text: string;
	label: string;
	onClick: () => void;
	extraClass?: string;
}

/**
 * A worded action, for the choices that end an edit.
 *
 * Words rather than icons (#138): a tick and a cross stacked beside the field
 * were small, pale and easy to miss. Obsidian's own button, as in the composer,
 * so both ways of writing a comment end the same way.
 */
function textButton(parent: HTMLElement, options: TextButtonOptions): HTMLElement {
	const button = parent.createEl("button", {
		cls: `inline-comment-btn${options.extraClass ? ` ${options.extraClass}` : ""}`,
		text: options.text,
		attr: { "aria-label": options.label },
	});
	button.addEventListener("click", (event) => {
		// The card navigates on click.
		event.stopPropagation();
		options.onClick();
	});
	return button;
}

/**
 * The text a thread points at now, falling back to what it was made on.
 *
 * No span means no current text to read, which covers an orphaned thread by
 * construction: buildThreads sets `orphaned` and nulls `position` from the same
 * failed match. A separate orphan check here read as more careful and was
 * redundant — a negative that removed it changed no outcome, which is how it
 * was found. An orphaned card keeps its stored words on purpose: that card
 * already explains itself, and showing nothing would be worse than showing
 * history. Same for a card drawn without the document at all.
 */
function currentText(thread: Thread, doc: string | undefined): string {
	if (doc === undefined || thread.position === null || thread.end === null) {
		return thread.root.anchor.selectedText;
	}
	return doc.slice(thread.position, thread.end);
}

/** Bind Enter to send and Shift+Enter to break the line. See keyIntent. */
function submitOnEnter(input: HTMLTextAreaElement, submit: () => void, cancel: () => void): void {
	input.addEventListener("keydown", (event) => {
		const intent = keyIntent(event);
		if (intent === "ignore" || intent === "newline") return;
		event.preventDefault();
		if (intent === "cancel") cancel();
		else submit();
	});
}

/** Render one thread — quote, comments, replies and the reply field. */
export function renderThreadCard(
	list: HTMLElement,
	thread: Thread,
	filePath: string,
	app: App,
	component: Component,
	actions: ThreadActions,
	options: CardOptions = {},
): HTMLElement {
	const card = list.createDiv({ cls: "inline-comment-card" });
	if (thread.orphaned) card.addClass("is-orphaned");
	if (thread.root.resolved) card.addClass("is-resolved");
	if (options.alwaysOpen) card.addClass("is-open");
	if (options.touch) card.addClass("is-touch");

	// A button only when there is somewhere to go: an orphaned thread's text is
	// no longer in the note, so a control promising to reveal it would lie.
	const reveal = options.onReveal !== undefined && !thread.orphaned;
	// An empty line has no text to quote, and the card used to render the blank:
	// 263x30px of nothing with the accent rule beside it, and an accessible name
	// reading `Go to "" in the note` (#97). What is named instead is the line.
	const quoted = currentText(thread, options.doc);
	const placeholder = quoted === "" ? emptyLineLabel(document.documentElement.lang) : null;
	const quote = reveal
		? card.createEl("button", {
				cls: "inline-comment-quote",
				attr: {
					"aria-label": placeholder
						? `Go to the ${placeholder.toLowerCase()} in the note`
						: `Go to "${quoted}" in the note`,
				},
			})
		: card.createDiv({ cls: "inline-comment-quote" });
	if (thread.orphaned) {
		setIcon(quote.createSpan({ cls: "inline-comment-quote-icon" }), "unlink");
	}
	// The full text as a tooltip, because the visible quote is clamped (#98) and
	// a long selection has to stay readable somewhere.
	if (!placeholder) quote.setAttribute("title", quoted);
	quote.createSpan({
		cls: placeholder ? "inline-comment-quote-text is-placeholder" : "inline-comment-quote-text",
		text: placeholder ?? quoted,
	});
	if (reveal) {
		quote.addEventListener("click", (event) => {
			// The card navigates on click too; without this the reveal runs twice.
			event.stopPropagation();
			options.onReveal!();
		});
	}

	// The quote alone reads as an ordinary card in a colour nobody has learnt
	// yet. Saying what happened is what turns a comment that goes nowhere from a
	// bug into a state, and the stored text above is all that is left of it.
	if (thread.orphaned) {
		card.createDiv({
			cls: "inline-comment-orphan-reason",
			text: orphanExplanation(thread, filePath),
		});
	}

	renderComment(card, thread.root, filePath, true, app, component, actions);
	for (const reply of thread.replies) {
		const replyEl = card.createDiv({ cls: "inline-comment-reply" });
		renderComment(replyEl, reply, filePath, false, app, component, actions);
	}

	renderReplyBox(card, thread.root, actions, options);
	return card;
}

function renderComment(
	parent: HTMLElement,
	comment: Comment,
	filePath: string,
	isRoot: boolean,
	app: App,
	component: Component,
	actions: ThreadActions,
): void {
	const meta = parent.createDiv({ cls: "inline-comment-meta" });
	meta.createSpan({ text: comment.author || "You", cls: "inline-comment-author" });
	meta.createSpan({ cls: "inline-comment-time", text: formatRelativeTime(comment.createdAt) });
	if (wasEdited(comment)) {
		meta.createSpan({ cls: "inline-comment-edited", text: "edited" });
	}

	const buttons = meta.createDiv({ cls: "inline-comment-actions" });
	const body = parent.createDiv({ cls: "inline-comment-body" });
	const showMore = renderShowMore(parent, body);

	// Only a thread root can be resolved: resolving a root resolves its thread.
	if (isRoot) {
		iconButton(buttons, {
			icon: comment.resolved ? "rotate-ccw" : "check",
			label: comment.resolved ? "Reopen" : "Resolve",
			extraClass: "inline-comment-action-resolve",
			onClick: () => void actions.setResolved(comment, !comment.resolved),
		});
	}
	// Named for what they act on. A thread with replies draws these buttons once
	// per comment, and a screen reader reading "Delete" four times down a card
	// cannot tell which one takes the whole conversation with it.
	const subject = isRoot ? "comment" : "reply";
	iconButton(buttons, {
		icon: "pencil",
		label: `Edit ${subject}`,
		onClick: () => startEditing(parent, body, showMore, comment, actions),
	});
	iconButton(buttons, {
		icon: "trash-2",
		label: `Delete ${subject}`,
		extraClass: "inline-comment-action-delete",
		onClick: () => actions.deleteComment(comment),
	});

	// Rendered rather than shown raw: comment bodies are Markdown, and the
	// component is passed so child views are cleaned up with their host.
	//
	// filePath is what internal links and embeds resolve against: a comment on
	// notes/deep/a.md saying [[target]] means the target that note means, not
	// whichever one happens to sit nearest the vault root.
	void MarkdownRenderer.render(app, comment.content, body, filePath, component).then(() => {
		// Measured after rendering because the height is a property of the output,
		// not of the Markdown: a table and a paragraph of the same length are not
		// the same number of lines.
		if (!shouldClamp(body.scrollHeight)) return;
		body.addClass("is-clipped");
		showMore.addClass("is-available");
		showMore.show();
	});
}

/**
 * The control that uncovers a clipped body.
 *
 * Built up front and hidden rather than created on demand: the height is only
 * known once the Markdown has rendered, and by then the buttons around it have
 * their listeners — appending afterwards would put it in the wrong place.
 */
function renderShowMore(parent: HTMLElement, body: HTMLElement): HTMLElement {
	const button = parent.createEl("button", { cls: "inline-comment-showmore", text: SHOW_MORE });
	button.hide();
	button.addEventListener("click", (event) => {
		// The card navigates to the anchor on click.
		event.stopPropagation();
		const wasClipped = body.hasClass("is-clipped");
		body.toggleClass("is-clipped", !wasClipped);
		button.setText(wasClipped ? SHOW_LESS : SHOW_MORE);
	});
	return button;
}

/** A reply field at the foot of the thread, which grows with the text. */
function renderReplyBox(
	card: HTMLElement,
	root: Comment,
	actions: ThreadActions,
	options: CardOptions,
): void {
	const toggle = options.touch
		? card.createEl("button", { cls: "inline-comment-reply-toggle", text: "Reply" })
		: null;
	const box = card.createDiv({ cls: "inline-comment-replybox" });
	const input = box.createEl("textarea", {
		cls: "inline-comment-replybox-input",
		attr: { rows: "1", placeholder: "Reply", "aria-label": "Write a reply" },
	});

	const send = box.createEl("button", {
		cls: "inline-comment-send",
		attr: { "aria-label": "Send reply", title: "Send reply" },
	});
	setIcon(send, "corner-down-left");

	const reset = (): void => {
		input.value = "";
		input.style.height = "";
		box.removeClass("is-active");
		toggle?.show();
	};

	const submit = (): void => {
		const content = input.value.trim();
		if (content === "") {
			reset();
			return;
		}
		reset();
		void actions.addReply(root, content).then(() => options.onReplied?.());
	};

	box.addEventListener("click", (event) => event.stopPropagation());
	input.addEventListener("focus", () => {
		box.addClass("is-active");
		toggle?.hide();
	});
	toggle?.addEventListener("click", (event) => {
		// The card navigates to the anchor on click.
		event.stopPropagation();
		box.addClass("is-active");
		toggle.hide();
		input.focus();
	});
	input.addEventListener("blur", () => {
		// Keep the box open while it holds a draft: collapsing it on blur would
		// throw away half-written text the moment the pointer wandered off.
		if (input.value.trim() === "") reset();
	});
	input.addEventListener("input", () => {
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	});
	submitOnEnter(input, submit, () => {
		input.blur();
		reset();
	});
	send.addEventListener("click", (event) => {
		event.stopPropagation();
		submit();
	});
}

/** Swap the rendered body for a textarea in place. */
function startEditing(
	parent: HTMLElement,
	body: HTMLElement,
	showMore: HTMLElement,
	comment: Comment,
	actions: ThreadActions,
): void {
	if (parent.querySelector(".inline-comment-editor")) return;

	// One text field at a time: the card's reply field hides while this is open (#138).
	const card = parent.closest(".inline-comment-card");
	card?.addClass("is-editing");
	body.hide();
	showMore.hide();
	// Where the body was, not at the end of the parent. A root comment's parent
	// is the whole card, so appending put the box under every reply and under
	// the reply field — the text being edited and the box editing it separated
	// by the entire conversation (#99).
	const editor = parent.createDiv({ cls: "inline-comment-editor" });
	body.insertAdjacentElement("afterend", editor);
	const textarea = editor.createEl("textarea", {
		cls: "inline-comment-editor-input",
		attr: { "aria-label": "Edit comment" },
	});
	textarea.value = comment.content;

	let onOutsidePress: ((event: MouseEvent) => void) | null = null;

	const finish = (): void => {
		if (onOutsidePress) {
			document.removeEventListener("mousedown", onOutsidePress);
			onOutsidePress = null;
		}
		editor.remove();
		card?.removeClass("is-editing");
		body.show();
		// Only if there was one to begin with: is-available records that decision,
		// which the expanded state does not — an expanded body has no is-clipped.
		if (showMore.hasClass("is-available")) showMore.show();
	};

	const save = (): void => {
		const content = textarea.value.trim();
		// An empty body would leave a card with nothing in it; treat it as a
		// cancel rather than silently destroying the text.
		if (content === "" || content === comment.content) {
			finish();
			return;
		}
		finish();
		void actions.editComment(comment, content);
	};

	const buttons = editor.createDiv({ cls: "inline-comment-editor-actions" });
	textButton(buttons, { text: "Cancel", label: "Cancel edit", onClick: finish });
	textButton(buttons, { text: "Save", label: "Save changes", onClick: save, extraClass: "mod-cta" });

	editor.addEventListener("click", (event) => event.stopPropagation());
	submitOnEnter(textarea, save, finish);

	// A press outside commits, it does not discard.
	//
	// Editing works on text that already exists, so losing an edit loses a
	// change to something real. The box had no rule at all before: a press
	// elsewhere in the panel left it open, and a press in the note made it
	// vanish with the draft inside it, because the panel repainted and took the
	// box with it (#114). Committing makes closing safe, and Escape and Cancel
	// stay the explicit way to throw a change away.
	//
	// `save` already declines an empty or unchanged body, so this closes quietly
	// when there is nothing to keep.
	//
	// Deferred a tick for the same reason the composer defers: the click that
	// opened this box is still propagating, and binding now would close it
	// immediately. The composer cancels on an outside press rather than
	// committing, deliberately — a new comment has nothing to preserve and an
	// empty one is a mis-click.
	window.setTimeout(() => {
		onOutsidePress = (event: MouseEvent): void => {
			if (!editor.contains(event.target as Node)) save();
		};
		document.addEventListener("mousedown", onOutsidePress);
	}, 0);

	textarea.focus();
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}
