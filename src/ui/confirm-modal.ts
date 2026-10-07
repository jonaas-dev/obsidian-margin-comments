import { App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
	/** Text on the confirming button. It names the act, never "OK". */
	confirmLabel?: string;
	/** The line under the question, saying what the act costs. */
	note?: string;
	/** Paints the confirming button as a warning. */
	destructive?: boolean;
}

/**
 * A blocking yes/no for actions worth a second look.
 *
 * A Modal here rather than an inline affordance: deleting a thread cannot be
 * undone, and a click that lands one pixel off should not be able to trigger it.
 * Reversible bulk actions use it too, with their own wording — telling someone a
 * resolve "cannot be undone" would be a lie that stops them using it.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly question: string,
		private readonly onConfirm: () => void | Promise<void>,
		private readonly options: ConfirmOptions = {},
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.question);
		this.contentEl.createEl("p", {
			text: this.options.note ?? "This cannot be undone.",
			cls: "inline-comment-confirm-note",
		});

		const label = this.options.confirmLabel ?? "Delete";
		const destructive = this.options.destructive ?? true;

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => {
				button.setButtonText(label).onClick(async () => {
					this.close();
					await this.onConfirm();
				});
				if (destructive) button.setDestructive();
				else button.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
