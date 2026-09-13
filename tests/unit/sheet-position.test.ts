import { describe, it, expect } from "vitest";
import { sheetPosition, SHEET_MAX_FRACTION } from "../../src/editor/floating-position";

/** A Pixel 8 in CSS pixels: 915 tall, with Obsidian's bottom bar 76px up. */
const PHONE = { innerHeight: 915, visibleHeight: 915, reservedBottom: 76 };

describe("sheetPosition", () => {
	it("sits on top of the app's navigation bar when there is no keyboard (#132)", () => {
		expect(sheetPosition(PHONE)).toEqual({ bottom: 76, maxHeight: Math.round((915 - 76) * SHEET_MAX_FRACTION) });
	});

	it("sits on top of the keyboard when the keyboard reaches higher", () => {
		// The keyboard covers the bar, so the bar's reservation no longer matters.
		const position = sheetPosition({ ...PHONE, visibleHeight: 515 });
		expect(position.bottom).toBe(400);
		expect(position.maxHeight).toBe(Math.round(515 * SHEET_MAX_FRACTION));
	});

	it("keeps the bar's reservation when the keyboard is shorter than the bar", () => {
		expect(sheetPosition({ ...PHONE, visibleHeight: 875 }).bottom).toBe(76);
	});

	it("reaches the bottom of the window when nothing is reserved", () => {
		expect(sheetPosition({ innerHeight: 640, visibleHeight: 640, reservedBottom: 0 })).toEqual({
			bottom: 0,
			maxHeight: 320,
		});
	});

	it("never reports a negative inset from a zoomed visual viewport", () => {
		// Pinch-zoom can report a visual viewport taller than the window.
		expect(sheetPosition({ innerHeight: 640, visibleHeight: 700, reservedBottom: 0 }).bottom).toBe(0);
	});

	it("leaves at least half the remaining height for the note", () => {
		const { bottom, maxHeight } = sheetPosition(PHONE);
		expect(maxHeight).toBeLessThanOrEqual((PHONE.innerHeight - bottom) / 2 + 0.5);
	});
});
