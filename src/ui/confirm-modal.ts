import { App, Modal, Setting } from "obsidian";

/**
 * A blocking yes/no for destructive actions.
 *
 * A Modal here rather than an inline affordance: deleting a thread cannot be
 * undone, and a click that lands one pixel off should not be able to trigger it.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private question: string,
		private onConfirm: () => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.question);
		this.contentEl.createEl("p", {
			text: "This cannot be undone.",
			cls: "inline-comment-confirm-note",
		});

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText("Delete")
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
