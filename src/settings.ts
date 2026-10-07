import { App, Plugin, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { FUZZY_THRESHOLD_MAX, FUZZY_THRESHOLD_MIN, type PluginSettings } from "./types";
import { describeFuzzy } from "./settings-values";
import { SORT_ORDERS, sortLabel } from "./ui/panel-sort";

/** Not a stored setting: the toggle that decides whether highlightColor is "theme". */
const FOLLOW_THEME = "followThemeAccent";

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
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	/**
	 * The settings, declared rather than drawn.
	 *
	 * Obsidian 1.13 indexes these for the settings modal's search. Measured on
	 * 1.13.7 before changing anything: with only `display()`, searching Settings
	 * for "author" returned "No settings found." while a control term returned
	 * Obsidian's own rows — so the tab really was invisible to search (#250).
	 *
	 * Values are read and written through getControlValue/setControlValue below,
	 * keyed by the settings field, so there is one place that knows how a change
	 * is persisted and applied.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Author name",
				desc: "Stamped on comments you write from now on. Existing comments keep the name they were written under.",
				control: { type: "text", key: "author", placeholder: "Unattributed" },
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Gutter icons",
						desc: "The markers in the left margin. With these off, comments can only be added with the Add comment to selection command.",
						control: { type: "toggle", key: "showGutterIcons" },
					},
					{
						name: "Comment count",
						desc: "Badges the gutter marker with the number of open threads on a line. A line with a single thread stays a bare icon.",
						control: { type: "toggle", key: "showCommentCount" },
					},
					{
						name: "Highlight commented lines",
						desc: "Tints lines carrying an open comment. Resolved threads are never tinted.",
						control: { type: "toggle", key: "showLineHighlights" },
					},
					{
						name: "Follow the theme accent",
						desc: "Tints from the accent color of whichever theme is active, so the highlight keeps working after a theme change.",
						control: { type: "toggle", key: FOLLOW_THEME },
					},
					{
						// American, like the rest of Obsidian's interface and like the
						// code behind it (`highlightColor`). The settings search filters
						// on this label, so "colour" meant a reader typing "color" did
						// not find the setting at all (#318).
						name: "Highlight color",
						desc: "Used instead of the theme accent, in every theme.",
						// Shown only while the theme is not driving the colour. This
						// used to be a re-call of display(), which on 1.13 does not
						// refresh declarative settings at all.
						visible: () => this.host.settings.highlightColor !== "theme",
						control: { type: "color", key: "highlightColor" },
					},
				],
			},
			{
				type: "group",
				heading: "Anchoring",
				items: [
					{
						name: "Fuzzy matching tolerance",
						// The number means nothing on its own; this sentence is the
						// only thing that says what it buys.
						desc: describeFuzzy(this.host.settings.fuzzyThreshold),
						control: {
							type: "slider",
							key: "fuzzyThreshold",
							min: FUZZY_THRESHOLD_MIN,
							max: FUZZY_THRESHOLD_MAX,
							step: 0.05,
						},
					},
					{
						name: "When a note is deleted",
						desc: "Deleted comments are kept and come back if the note does, so closing Obsidian no longer ends them. Kept comments stay readable under a 'not found' note in the all-notes view.",
						control: {
							type: "dropdown",
							key: "orphanedBehavior",
							options: { delete: "Delete its comments", keep: "Keep its comments" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Panel",
				items: [
					{
						name: "Side",
						desc: "Which sidebar the comments panel opens in. An open panel moves immediately.",
						control: {
							type: "dropdown",
							key: "panelPosition",
							options: { right: "Right", left: "Left" },
						},
					},
					{
						name: "Sort order",
						desc: "Also changed by the dropdown in the panel itself, which writes the same setting.",
						control: {
							type: "dropdown",
							key: "sortOrder",
							options: Object.fromEntries(SORT_ORDERS.map((o) => [o, sortLabel(o)])),
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		// Not a stored field: the toggle asks whether the theme drives the colour,
		// which is what "theme" in highlightColor means.
		if (key === FOLLOW_THEME) return this.host.settings.highlightColor === "theme";
		return this.host.settings[key as keyof PluginSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.host.settings;
		switch (key) {
			case FOLLOW_THEME:
				settings.highlightColor = value === true ? "theme" : "#ffb454";
				this.host.applyHighlightColour();
				// The colour picker appears or disappears with this, and its
				// visibility is a predicate rather than a redraw.
				this.refreshDomState();
				break;
			case "highlightColor":
				settings.highlightColor = String(value);
				this.host.applyHighlightColour();
				break;
			case "author":
				settings.author = String(value).trim();
				break;
			case "fuzzyThreshold":
				settings.fuzzyThreshold = Number(value);
				// The description quotes the value, so the definitions have to be
				// rebuilt rather than merely re-evaluated.
				this.update();
				break;
			case "orphanedBehavior":
				settings.orphanedBehavior = value === "keep" ? "keep" : "delete";
				break;
			case "panelPosition":
				settings.panelPosition = value === "left" ? "left" : "right";
				await this.host.save();
				await this.host.movePanel();
				return;
			case "sortOrder": {
				const chosen = SORT_ORDERS.find((order) => order === value);
				if (chosen) settings.sortOrder = chosen;
				break;
			}
			default:
				settings[key as "showGutterIcons"] = value === true;
		}
		await this.host.save();
		await this.host.refresh();
	}
}
