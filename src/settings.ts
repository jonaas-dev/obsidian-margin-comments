import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { FUZZY_THRESHOLD_MAX, FUZZY_THRESHOLD_MIN, type PluginSettings } from "./types";
import { describeFuzzy } from "./settings-values";
import { SORT_ORDERS, sortLabel } from "./ui/panel-sort";

/**
 * What the tab needs from the plugin.
 *
 * Extends Plugin because Obsidian's own PluginSettingTab constructor takes one
 * for its bookkeeping; the members below are what this file actually calls, and
 * naming them keeps the dependency one-way.
 */
export interface SettingsHost extends Plugin {
	settings: PluginSettings;
	/** Persist the settings object as it now stands. */
	save(): Promise<void>;
	/** Redraw gutter markers, highlights and the panel from the new settings. */
	refresh(): Promise<void>;
	/** Publish the highlight colour to the stylesheet. */
	applyHighlightColour(): void;
	/** Move an open panel to the configured side; a no-op when none is open. */
	movePanel(): Promise<void>;
}

/**
 * The settings tab.
 *
 * Every control writes, saves and applies in one step. Obsidian's own tabs have
 * no Save button and neither does this one, so a change that needed a reload to
 * show would read as a control that did nothing.
 *
 * Descriptions say what the setting does to the reader's notes, not what its
 * label already says. "Show gutter icons — shows icons in the gutter" is a line
 * that costs a row of screen and answers nothing.
 */
export class InlineCommentsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private host: SettingsHost,
	) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderAuthor(containerEl);
		this.renderAppearance(containerEl);
		this.renderAnchoring(containerEl);
		this.renderPanel(containerEl);
	}

	/** Write, persist, and let the plugin act on it. */
	private commit(apply: () => void = () => undefined): void {
		void (async () => {
			apply();
			await this.host.save();
			await this.host.refresh();
		})();
	}

	private renderAuthor(container: HTMLElement): void {
		new Setting(container)
			.setName("Author name")
			.setDesc(
				"Stamped on comments you write from now on. Existing comments keep the name they were written under.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Unattributed")
					.setValue(this.host.settings.author)
					.onChange((value) =>
						this.commit(() => (this.host.settings.author = value.trim())),
					),
			);
	}

	private renderAppearance(container: HTMLElement): void {
		new Setting(container).setName("Appearance").setHeading();

		new Setting(container)
			.setName("Gutter icons")
			.setDesc(
				"The markers in the left margin. With these off, comments can only be added with the Add comment to selection command.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showGutterIcons)
					.onChange((value) =>
						this.commit(() => (this.host.settings.showGutterIcons = value)),
					),
			);

		new Setting(container)
			.setName("Comment count")
			.setDesc(
				"Badges the gutter marker with the number of open threads on a line. A line with a single thread stays a bare icon.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showCommentCount)
					.onChange((value) =>
						this.commit(() => (this.host.settings.showCommentCount = value)),
					),
			);

		new Setting(container)
			.setName("Highlight commented lines")
			.setDesc("Tints lines carrying an open comment. Resolved threads are never tinted.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showLineHighlights)
					.onChange((value) =>
						this.commit(() => (this.host.settings.showLineHighlights = value)),
					),
			);

		const custom = this.host.settings.highlightColor !== "theme";
		new Setting(container)
			.setName("Follow the theme accent")
			.setDesc(
				"Tints from the accent colour of whichever theme is active, so the highlight keeps working after a theme change.",
			)
			.addToggle((toggle) =>
				toggle.setValue(!custom).onChange((followTheme) => {
					this.host.settings.highlightColor = followTheme ? "theme" : "#ffb454";
					this.commit(() => this.host.applyHighlightColour());
					// Redrawn rather than hidden: the colour picker is only
					// meaningful while the theme is not driving the colour.
					this.display();
				}),
			);

		if (custom) {
			new Setting(container)
				.setName("Highlight colour")
				.setDesc("Used instead of the theme accent, in every theme.")
				.addColorPicker((picker) =>
					picker.setValue(this.host.settings.highlightColor).onChange((value) =>
						this.commit(() => {
							this.host.settings.highlightColor = value;
							this.host.applyHighlightColour();
						}),
					),
				);
		}
	}

	private renderAnchoring(container: HTMLElement): void {
		new Setting(container).setName("Anchoring").setHeading();

		const fuzzy = new Setting(container)
			.setName("Fuzzy matching tolerance")
			.setDesc(describeFuzzy(this.host.settings.fuzzyThreshold));

		fuzzy.addSlider((slider) =>
			slider
				.setLimits(FUZZY_THRESHOLD_MIN, FUZZY_THRESHOLD_MAX, 0.05)
				.setValue(this.host.settings.fuzzyThreshold)
				.setDynamicTooltip()
				.onChange((value) =>
					this.commit(() => {
						this.host.settings.fuzzyThreshold = value;
						// The number means nothing on its own; the sentence under
						// the label is the only thing that says what it buys.
						fuzzy.setDesc(describeFuzzy(value));
					}),
				),
		);

		new Setting(container)
			.setName("When a note is deleted")
			.setDesc(
				"Deleted comments come back if the note is restored before Obsidian closes. Kept comments stay readable under a 'not found' note in the all-notes view.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("delete", "Delete its comments")
					.addOption("keep", "Keep its comments")
					.setValue(this.host.settings.orphanedBehavior)
					.onChange((value) =>
						this.commit(() => {
							this.host.settings.orphanedBehavior =
								value === "keep" ? "keep" : "delete";
						}),
					),
			);
	}

	private renderPanel(container: HTMLElement): void {
		new Setting(container).setName("Panel").setHeading();

		new Setting(container)
			.setName("Side")
			.setDesc("Which sidebar the comments panel opens in. An open panel moves immediately.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("right", "Right")
					.addOption("left", "Left")
					.setValue(this.host.settings.panelPosition)
					.onChange((value) => {
						this.host.settings.panelPosition = value === "left" ? "left" : "right";
						void (async () => {
							await this.host.save();
							await this.host.movePanel();
						})();
					}),
			);

		new Setting(container)
			.setName("Sort order")
			.setDesc(
				"Also changed by the dropdown in the panel itself, which writes the same setting.",
			)
			.addDropdown((dropdown) => {
				for (const order of SORT_ORDERS) dropdown.addOption(order, sortLabel(order));
				dropdown.setValue(this.host.settings.sortOrder).onChange((value) =>
					this.commit(() => {
						const chosen = SORT_ORDERS.find((order) => order === value);
						if (chosen) this.host.settings.sortOrder = chosen;
					}),
				);
			});
	}
}
