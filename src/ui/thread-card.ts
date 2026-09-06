import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import type { Comment } from "../types";
import { formatRelativeTime, type Thread } from "./threads";
import { orphanExplanation } from "./orphans";
import { wasEdited } from "./comment-actions";
import { keyIntent } from "./key-intent";

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
}

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
	const button = parent.createEl("button", {
		cls: `inline-comment-action${options.extraClass ? ` ${options.extraClass}` : ""}`,
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

	const quote = card.createDiv({ cls: "inline-comment-quote" });
	if (thread.orphaned) {
		setIcon(quote.createSpan({ cls: "inline-comment-quote-icon" }), "unlink");
	}
	quote.createSpan({ text: thread.root.anchor.selectedText });

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

	// Only a thread root can be resolved: resolving a root resolves its thread.
	if (isRoot) {
		iconButton(buttons, {
			icon: comment.resolved ? "rotate-ccw" : "check",
			label: comment.resolved ? "Reopen" : "Resolve",
			extraClass: "inline-comment-action-resolve",
			onClick: () => void actions.setResolved(comment, !comment.resolved),
		});
	}
	iconButton(buttons, {
		icon: "pencil",
		label: "Edit",
		onClick: () => startEditing(parent, body, comment, actions),
	});
	iconButton(buttons, {
		icon: "trash-2",
		label: "Delete",
		extraClass: "inline-comment-action-delete",
		onClick: () => actions.deleteComment(comment),
	});

	// Rendered rather than shown raw: comment bodies are Markdown, and the
	// component is passed so child views are cleaned up with their host.
	void MarkdownRenderer.render(app, comment.content, body, filePath, component);
}

/** A reply field at the foot of the thread, which grows with the text. */
function renderReplyBox(
	card: HTMLElement,
	root: Comment,
	actions: ThreadActions,
	options: CardOptions,
): void {
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
	input.addEventListener("focus", () => box.addClass("is-active"));
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
	comment: Comment,
	actions: ThreadActions,
): void {
	if (parent.querySelector(".inline-comment-editor")) return;

	body.hide();
	const editor = parent.createDiv({ cls: "inline-comment-editor" });
	const textarea = editor.createEl("textarea", {
		cls: "inline-comment-editor-input",
		attr: { "aria-label": "Edit comment" },
	});
	textarea.value = comment.content;

	const finish = (): void => {
		editor.remove();
		body.show();
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
	iconButton(buttons, { icon: "x", label: "Cancel edit", onClick: finish });
	iconButton(buttons, {
		icon: "check",
		label: "Save changes",
		extraClass: "inline-comment-action-save",
		onClick: save,
	});

	editor.addEventListener("click", (event) => event.stopPropagation());
	submitOnEnter(textarea, save, finish);

	textarea.focus();
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}
