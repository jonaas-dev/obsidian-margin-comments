import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, FUZZY_THRESHOLD_MIN, FUZZY_THRESHOLD_MAX } from "../../src/types";

describe("DEFAULT_SETTINGS", () => {
	it("keeps the fuzzy threshold inside the range the settings tab enforces", () => {
		expect(DEFAULT_SETTINGS.fuzzyThreshold).toBeGreaterThanOrEqual(FUZZY_THRESHOLD_MIN);
		expect(DEFAULT_SETTINGS.fuzzyThreshold).toBeLessThanOrEqual(FUZZY_THRESHOLD_MAX);
	});

	it("declares a usable threshold range", () => {
		expect(FUZZY_THRESHOLD_MIN).toBeLessThan(FUZZY_THRESHOLD_MAX);
	});

	it("defaults to following the Obsidian theme rather than a fixed colour", () => {
		expect(DEFAULT_SETTINGS.highlightColor).toBe("theme");
	});

	it("keeps orphaned comments by default", () => {
		// Silently deleting a user's comment because its anchor text moved is not
		// a default anyone would choose knowingly.
		expect(DEFAULT_SETTINGS.orphanedBehavior).toBe("keep");
	});

	it("starts with an empty author so nothing is attributed to a guessed name", () => {
		expect(DEFAULT_SETTINGS.author).toBe("");
	});
});
