import { Plugin } from "obsidian";

export default class InlineCommentsPlugin extends Plugin {
	async onload(): Promise<void> {
		// Everything registered from here must be torn down automatically: use
		// registerEvent / registerInterval / registerEditorExtension so onunload
		// stays empty of manual cleanup.
	}

	onunload(): void {
		// Intentionally empty while nothing is registered manually.
	}
}
