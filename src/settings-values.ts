import {
	FUZZY_THRESHOLD_MAX,
	FUZZY_THRESHOLD_MIN,
	type HighlightColor,
	type OrphanedBehavior,
	type PanelPosition,
} from "./types";
import { highlightOverride } from "./appearance";

/**
 * Read back a stored setting, tolerating anything that is not one.
 *
 * `data.json` outlives the version that wrote it and can be hand-edited — it is
 * the only way to reach a setting the tab does not expose — so what comes back
 * is input, not state. Every one of these falls back rather than throwing: a
 * plugin that refuses to load because one field is wrong is worse than a plugin
 * that ignores it.
 */
export function toFuzzyThreshold(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	// Clamped rather than rejected: a number outside the range is a preference
	// pushed too far, not a typo, and the nearest legal value is what was meant.
	return Math.min(FUZZY_THRESHOLD_MAX, Math.max(FUZZY_THRESHOLD_MIN, value));
}

export function toOrphanedBehavior(value: unknown, fallback: OrphanedBehavior): OrphanedBehavior {
	return value === "keep" || value === "delete" ? value : fallback;
}

export function toPanelPosition(value: unknown, fallback: PanelPosition): PanelPosition {
	return value === "left" || value === "right" ? value : fallback;
}

/** "theme", or a colour the stylesheet can actually use. */
export function toHighlightColor(value: unknown, fallback: HighlightColor): HighlightColor {
	if (value === "theme") return "theme";
	if (typeof value !== "string" || highlightOverride(value) === null) return fallback;
	return value;
}

/** Trimmed, because a name of spaces is stamped on comments as an empty one. */
export function toAuthor(value: unknown, fallback: string): string {
	return typeof value === "string" ? value.trim() : fallback;
}

/** What the fuzzy slider is actually promising, in words rather than a number. */
export function describeFuzzy(threshold: number): string {
	if (threshold <= 0.15) return "Strict: only near-identical text is recognized.";
	if (threshold >= 0.4)
		return "Loose: heavily rewritten text is still recognized, sometimes wrongly.";
	return "Balanced: text that was edited is recognized, text that was replaced is not.";
}
