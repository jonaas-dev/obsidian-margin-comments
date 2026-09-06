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

	it("takes a note's comments with it when the note is deleted", () => {
		// The setting no longer means "delete an orphan after a while" — nothing
		// deletes a comment on a timer. It means what happens when the user
		// deletes the note, and taking the comments along is what they asked for.
		// Safe because restoring the note within the session brings them back.
		expect(DEFAULT_SETTINGS.orphanedBehavior).toBe("delete");
	});

	it("starts with an empty author so nothing is attributed to a guessed name", () => {
		expect(DEFAULT_SETTINGS.author).toBe("");
	});
});
