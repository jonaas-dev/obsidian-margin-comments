import { describe, it, expect } from "vitest";
import {
	describeFuzzy,
	toAuthor,
	toFuzzyThreshold,
	toHighlightColor,
	toOrphanedBehavior,
	toPanelPosition,
} from "../../src/settings-values";
import { DEFAULT_SETTINGS, FUZZY_THRESHOLD_MAX, FUZZY_THRESHOLD_MIN } from "../../src/types";

describe("toFuzzyThreshold", () => {
	it("keeps a value inside the range", () => {
		expect(toFuzzyThreshold(0.25, 0.3)).toBe(0.25);
	});

	it("clamps rather than rejects a value pushed too far", () => {
		// A number out of range is a preference, not a typo, and the nearest
		// legal value is what was meant.
		expect(toFuzzyThreshold(0.9, 0.3)).toBe(FUZZY_THRESHOLD_MAX);
		expect(toFuzzyThreshold(0, 0.3)).toBe(FUZZY_THRESHOLD_MIN);
	});

	it("falls back for anything that is not a finite number", () => {
		// A NaN threshold makes every comparison false, so no comment ever
		// re-anchors and the whole fuzzy stage goes quietly dead.
		expect(toFuzzyThreshold(Number.NaN, 0.3)).toBe(0.3);
		expect(toFuzzyThreshold("0.4", 0.3)).toBe(0.3);
		expect(toFuzzyThreshold(null, 0.3)).toBe(0.3);
		expect(toFuzzyThreshold(undefined, 0.3)).toBe(0.3);
	});
});

describe("toOrphanedBehavior", () => {
	it("takes either of the two it knows", () => {
		expect(toOrphanedBehavior("keep", "delete")).toBe("keep");
		expect(toOrphanedBehavior("delete", "keep")).toBe("delete");
	});

	it("falls back for anything else", () => {
		expect(toOrphanedBehavior("after 30 days", "delete")).toBe("delete");
		expect(toOrphanedBehavior(30, "delete")).toBe("delete");
	});
});

describe("toPanelPosition", () => {
	it("takes either side", () => {
		expect(toPanelPosition("left", "right")).toBe("left");
		expect(toPanelPosition("right", "left")).toBe("right");
	});

	it("falls back for anything else", () => {
		expect(toPanelPosition("bottom", "right")).toBe("right");
	});
});

describe("toHighlightColor", () => {
	it("keeps the theme default", () => {
		expect(toHighlightColor("theme", "theme")).toBe("theme");
	});

	it("keeps a usable colour", () => {
		expect(toHighlightColor("#ffb454", "theme")).toBe("#ffb454");
	});

	it("falls back for a colour the stylesheet could not use", () => {
		// Written straight through, it clears the tint on every commented line,
		// which reads as the highlights breaking rather than a bad setting.
		expect(toHighlightColor("burnt orange", "theme")).toBe("theme");
		expect(toHighlightColor(16750848, "theme")).toBe("theme");
	});
});

describe("toAuthor", () => {
	it("trims, so a name of spaces is not stamped on every comment", () => {
		expect(toAuthor("  Ada  ", "")).toBe("Ada");
		expect(toAuthor("   ", "")).toBe("");
	});

	it("falls back for anything that is not text", () => {
		expect(toAuthor(42, "")).toBe("");
		expect(toAuthor(null, "")).toBe("");
	});
});

describe("describeFuzzy", () => {
	it("says something different at each end of the range", () => {
		const strict = describeFuzzy(FUZZY_THRESHOLD_MIN);
		const loose = describeFuzzy(FUZZY_THRESHOLD_MAX);
		expect(strict).not.toBe(loose);
		expect(strict).toContain("Strict");
		expect(loose).toContain("Loose");
	});

	it("warns that a loose setting recognises the wrong text", () => {
		// The cost of the slider's right-hand end is the whole reason to say
		// anything at all; a number cannot carry it.
		expect(describeFuzzy(FUZZY_THRESHOLD_MAX)).toContain("wrongly");
	});

	it("describes the shipped default as balanced", () => {
		expect(describeFuzzy(DEFAULT_SETTINGS.fuzzyThreshold)).toContain("Balanced");
	});
});
