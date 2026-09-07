import { describe, it, expect } from "vitest";
import { MAX_BODY_HEIGHT, shouldClamp } from "../../src/ui/clamp";

describe("shouldClamp", () => {
	it("leaves a body that fits alone", () => {
		expect(shouldClamp(MAX_BODY_HEIGHT - 1)).toBe(false);
	});

	it("leaves a body that only just overflows", () => {
		// A "Show more" that reveals one extra line reads as a broken button, so
		// the control is worth its space only past a margin.
		expect(shouldClamp(MAX_BODY_HEIGHT + 1)).toBe(false);
		expect(shouldClamp(MAX_BODY_HEIGHT + 40)).toBe(false);
	});

	it("clips a body that would take over the panel", () => {
		expect(shouldClamp(MAX_BODY_HEIGHT + 41)).toBe(true);
		expect(shouldClamp(MAX_BODY_HEIGHT * 5)).toBe(true);
	});

	it("honours a caller-supplied cap, so the test is not asserting the default twice", () => {
		expect(shouldClamp(100, 10)).toBe(true);
		expect(shouldClamp(100, 500)).toBe(false);
	});
});
