import { describe, it, expect } from "vitest";
import { highlightOverride, HIGHLIGHT_VARIABLE } from "../../src/appearance";

describe("highlightOverride", () => {
	it("sets nothing for the theme default", () => {
		// Not an approximation of the accent: the stylesheet already falls back
		// to it, so the property is removed rather than guessed at.
		expect(highlightOverride("theme")).toBeNull();
	});

	it("passes a six-digit hex through", () => {
		expect(highlightOverride("#ff8800")).toBe("#ff8800");
	});

	it("accepts the shorthand and the alpha forms", () => {
		expect(highlightOverride("#f80")).toBe("#f80");
		expect(highlightOverride("#ff880080")).toBe("#ff880080");
	});

	it("is case-insensitive, since a colour picker may hand back either", () => {
		expect(highlightOverride("#FF8800")).toBe("#FF8800");
	});

	it("refuses a value that is not a colour", () => {
		// data.json is hand-edited. A typo written straight into the custom
		// property paints every commented line transparent, which reads as the
		// highlights being broken rather than as a bad setting.
		expect(highlightOverride("orange")).toBeNull();
		expect(highlightOverride("#gg8800")).toBeNull();
		// Five digits is no CSS form; four is the RGBA shorthand and is accepted.
		expect(highlightOverride("#ff888")).toBeNull();
		expect(highlightOverride("")).toBeNull();
		expect(highlightOverride("ff8800")).toBeNull();
	});

	it("names a custom property, not a plain word", () => {
		// setProperty silently ignores a name without the leading dashes, so the
		// colour would never appear and nothing would say why.
		expect(HIGHLIGHT_VARIABLE.startsWith("--")).toBe(true);
	});
});
