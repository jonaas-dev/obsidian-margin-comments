import type { HighlightColor } from "./types";

/** The custom property the stylesheet reads for the highlight colour. */
export const HIGHLIGHT_VARIABLE = "--ic-highlight";

/** Any CSS hex colour, three to eight digits, so alpha forms are accepted too. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The value to set on the highlight custom property, or null to let the theme
 * have it back.
 *
 * "theme" is not a colour, it is the absence of an override: the stylesheet
 * already falls back to the Obsidian accent, so the property is removed rather
 * than set to something that approximates it. A stored value that is neither
 * "theme" nor a hex colour is treated the same way — `data.json` is hand-edited,
 * and a typo that paints every commented line transparent would look like the
 * highlights breaking.
 */
export function highlightOverride(colour: HighlightColor): string | null {
	if (colour === "theme" || !HEX.test(colour)) return null;
	return colour;
}
