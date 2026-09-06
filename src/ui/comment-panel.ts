import { ItemView, MarkdownRenderer, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Comment } from "../types";
import { buildThreads, formatRelativeTime, type Thread } from "./threads";
import { wasEdited } from "./comment-actions";

export const COMMENT_PANEL_VIEW = "inline-comments-panel";

export interface PanelHost {
	/** Comments for the active note, plus the note's text to anchor them against. */
	loadActive(): Promise<{ filePath: string; doc: string; comments: Comment[] } | null>;
	/** Scroll the editor to a thread's anchor. */
	revealThread(thread: Thread): void;
	/** Store a reply to the given thread root. */
	addReply(root: Comment, content: string): Promise<void>;
	/** Persist an edited body. */
	editComment(comment: Comment, content: string): Promise<void>;
	/** Resolve or reopen a thread root. */
	setResolved(root: Comment, resolved: boolean): Promise<void>;
	/** Confirm, then delete the comment and any replies it owns. */
	deleteComment(comment: Comment): void;
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
 * Obsidian's own icon set rather than text or emoji, so the panel reads as part
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

export class CommentPanelView extends ItemView {
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

	async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("inline-comment-panel");

		const active = await this.host.loadActive();
		if (!active) {
			this.renderEmpty(container, "Open a note to see its comments.");
			return;
		}

		const threads = buildThreads(active.doc, active.comments);
		if (threads.length === 0) {
			this.renderEmpty(container, "Hover the left edge of a line to add the first comment.");
			return;
		}

		const header = container.createDiv({ cls: "inline-comment-panel-header" });
		header.createSpan({
			cls: "inline-comment-panel-title",
			text: active.filePath.replace(/\.md$/, "").split("/").pop() ?? "",
		});
		header.createSpan({
			cls: "inline-comment-panel-count",
			text: `${threads.length}`,
		});

		const list = container.createDiv({ cls: "inline-comment-list" });
		for (const thread of threads) {
			this.renderThread(list, thread, active.filePath);
		}
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		// An empty state that says what to do next, so it never reads as broken.
		container.createDiv({ cls: "inline-comment-empty", text: message });
	}

	private renderThread(list: HTMLElement, thread: Thread, filePath: string): void {
		const card = list.createDiv({ cls: "inline-comment-card" });
		if (thread.orphaned) card.addClass("is-orphaned");
		if (thread.root.resolved) card.addClass("is-resolved");

		const quote = card.createDiv({ cls: "inline-comment-quote" });
		if (thread.orphaned) {
			setIcon(quote.createSpan({ cls: "inline-comment-quote-icon" }), "unlink");
		}
		quote.createSpan({ text: thread.root.anchor.selectedText });

		this.renderComment(card, thread.root, filePath, thread);
		for (const reply of thread.replies) {
			const replyEl = card.createDiv({ cls: "inline-comment-reply" });
			this.renderComment(replyEl, reply, filePath, null);
		}

		this.renderReplyBox(card, thread.root);

		if (!thread.orphaned) {
			card.addEventListener("click", () => this.host.revealThread(thread));
		}
	}

	private renderComment(
		parent: HTMLElement,
		comment: Comment,
		filePath: string,
		thread: Thread | null,
	): void {
		const meta = parent.createDiv({ cls: "inline-comment-meta" });
		meta.createSpan({ text: comment.author || "You", cls: "inline-comment-author" });
		meta.createSpan({
			cls: "inline-comment-time",
			text: formatRelativeTime(comment.createdAt),
		});
		if (wasEdited(comment)) {
			meta.createSpan({ cls: "inline-comment-edited", text: "edited" });
		}

		const actions = meta.createDiv({ cls: "inline-comment-actions" });
		const body = parent.createDiv({ cls: "inline-comment-body" });

		// Only a thread root can be resolved: resolving a root resolves its thread.
		if (thread) {
			iconButton(actions, {
				icon: comment.resolved ? "rotate-ccw" : "check",
				label: comment.resolved ? "Reopen" : "Resolve",
				extraClass: "inline-comment-action-resolve",
				onClick: () => void this.host.setResolved(comment, !comment.resolved),
			});
		}
		iconButton(actions, {
			icon: "pencil",
			label: "Edit",
			onClick: () => this.startEditing(parent, body, comment),
		});
		iconButton(actions, {
			icon: "trash-2",
			label: "Delete",
			extraClass: "inline-comment-action-delete",
			onClick: () => this.host.deleteComment(comment),
		});

		// Rendered rather than shown raw: comment bodies are Markdown, and the
		// plugin is passed as the lifecycle component so child views are cleaned up.
		void MarkdownRenderer.render(this.app, comment.content, body, filePath, this);
	}

	/**
	 * A reply field at the foot of the thread, which grows when focused.
	 *
	 * Inline rather than the floating composer: that one is anchored to text in
	 * the editor, and a popup opening away from the thread breaks the continuity
	 * of reading a conversation and writing into it.
	 */
	private renderReplyBox(card: HTMLElement, root: Comment): void {
		const box = card.createDiv({ cls: "inline-comment-replybox" });
		const input = box.createEl("textarea", {
			cls: "inline-comment-replybox-input",
			attr: { rows: "1", placeholder: "Reply", "aria-label": "Write a reply" },
		});

		const actions = box.createDiv({ cls: "inline-comment-replybox-actions" });
		const send = actions.createEl("button", {
			cls: "inline-comment-send",
			attr: { "aria-label": "Send reply", title: "Send reply" },
		});
		setIcon(send, "corner-down-left");

		const reset = (): void => {
			input.value = "";
			input.style.height = "";
			box.removeClass("is-active");
		};

		const submit = async (): Promise<void> => {
			const content = input.value.trim();
			if (content === "") {
				reset();
				return;
			}
			reset();
			await this.host.addReply(root, content);
		};

		box.addEventListener("click", (event) => event.stopPropagation());
		input.addEventListener("focus", () => box.addClass("is-active"));
		input.addEventListener("blur", () => {
			// Keep the box open while it holds a draft: collapsing it on blur would
			// throw away half-written text the moment the pointer wandered off.
			if (input.value.trim() === "") reset();
		});
		input.addEventListener("input", () => {
			// Grow with the text instead of scrolling inside two visible lines.
			input.style.height = "auto";
			input.style.height = `${input.scrollHeight}px`;
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				input.blur();
				reset();
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void submit();
			}
		});
		send.addEventListener("click", (event) => {
			event.stopPropagation();
			void submit();
		});
	}

	/**
	 * Swap the rendered body for a textarea in place.
	 *
	 * In place rather than in the floating composer: an edit started from the
	 * panel has no anchor in the editor to sit beside.
	 */
	private startEditing(parent: HTMLElement, body: HTMLElement, comment: Comment): void {
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

		const save = async (): Promise<void> => {
			const content = textarea.value.trim();
			// An empty body would leave a card with nothing in it; treat it as a
			// cancel rather than silently destroying the text.
			if (content === "" || content === comment.content) {
				finish();
				return;
			}
			finish();
			await this.host.editComment(comment, content);
		};

		const actions = editor.createDiv({ cls: "inline-comment-editor-actions" });
		iconButton(actions, { icon: "x", label: "Cancel edit", onClick: finish });
		iconButton(actions, {
			icon: "check",
			label: "Save changes",
			extraClass: "inline-comment-action-save",
			onClick: () => void save(),
		});

		editor.addEventListener("click", (event) => event.stopPropagation());
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				finish();
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void save();
			}
		});

		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}
}
