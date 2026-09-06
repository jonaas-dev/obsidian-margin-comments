import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import type { Comment } from "../types";
import { buildThreads, formatRelativeTime, type Thread } from "./threads";

export const COMMENT_PANEL_VIEW = "inline-comments-panel";

export interface PanelHost {
	/** Comments for the active note, plus the note's text to anchor them against. */
	loadActive(): Promise<{ filePath: string; doc: string; comments: Comment[] } | null>;
	/** Scroll the editor to a thread's anchor. */
	revealThread(thread: Thread): void;
	/** Compose a reply to `target`, anchored beside the given element. */
	replyTo(target: Comment, near: HTMLElement): void;
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
			this.renderEmpty(container, "No comments in this note yet.");
			return;
		}

		const header = container.createDiv({ cls: "inline-comment-panel-header" });
		header.createSpan({ text: active.filePath.replace(/\.md$/, "") });
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
		// A deliberate empty state, so an empty panel never reads as a broken one.
		container.createDiv({ cls: "inline-comment-empty", text: message });
	}

	private renderThread(list: HTMLElement, thread: Thread, filePath: string): void {
		const card = list.createDiv({ cls: "inline-comment-card" });
		if (thread.orphaned) card.addClass("inline-comment-orphaned");
		if (thread.root.resolved) card.addClass("inline-comment-resolved");

		const quote = card.createDiv({ cls: "inline-comment-quote" });
		quote.setText(
			thread.orphaned
				? `Anchor lost: “${thread.root.anchor.selectedText}”`
				: thread.root.anchor.selectedText,
		);

		this.renderComment(card, thread.root, filePath);
		for (const reply of thread.replies) {
			const replyEl = card.createDiv({ cls: "inline-comment-reply" });
			this.renderComment(replyEl, reply, filePath);
		}

		const footer = card.createDiv({ cls: "inline-comment-card-footer" });
		if (thread.replies.length > 0) {
			footer.createSpan({
				cls: "inline-comment-reply-count",
				text: `${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`,
			});
		}
		const reply = footer.createEl("button", {
			cls: "inline-comment-btn inline-comment-reply-btn",
			text: "Reply",
		});
		reply.addEventListener("click", (event) => {
			// The card navigates on click; a button inside it must not do both.
			event.stopPropagation();
			this.host.replyTo(thread.root, reply);
		});

		if (!thread.orphaned) {
			card.addEventListener("click", () => this.host.revealThread(thread));
		}
	}

	private renderComment(parent: HTMLElement, comment: Comment, filePath: string): void {
		const meta = parent.createDiv({ cls: "inline-comment-meta" });
		meta.createSpan({ text: comment.author || "Unknown", cls: "inline-comment-author" });
		meta.createSpan({ text: formatRelativeTime(comment.createdAt) });
		if (comment.updatedAt > comment.createdAt) meta.createSpan({ text: "edited" });

		const body = parent.createDiv({ cls: "inline-comment-body" });
		// Rendered rather than shown raw: comment bodies are Markdown, and the
		// plugin is passed as the lifecycle component so child views are cleaned up.
		void MarkdownRenderer.render(this.app, comment.content, body, filePath, this);
	}
}
