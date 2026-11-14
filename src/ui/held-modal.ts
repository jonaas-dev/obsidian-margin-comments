import { App, SuggestModal } from "obsidian";
import { describeHeldEntry } from "../deleted-notes";
import type { HeldEntry } from "../storage";

/** Picks which held entry to bring back; newest first, since that is what is usually wanted. */
export class HeldEntryModal extends SuggestModal<HeldEntry> {
	constructor(
		app: App,
		private readonly entries: HeldEntry[],
		private readonly onChoose: (entry: HeldEntry) => void,
	) {
		super(app);
		this.setPlaceholder("Choose the comments to restore to this note");
	}

	getSuggestions(query: string): HeldEntry[] {
		const needle = query.toLowerCase();
		return this.entries
			.filter((entry) => entry.filePath.toLowerCase().includes(needle))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	renderSuggestion(entry: HeldEntry, el: HTMLElement): void {
		el.setText(describeHeldEntry(entry.filePath, entry.openThreads, entry.updatedAt));
	}

	onChooseSuggestion(entry: HeldEntry): void {
		this.onChoose(entry);
	}
}
