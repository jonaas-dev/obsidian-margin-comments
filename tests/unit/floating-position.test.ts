import { describe, it, expect } from "vitest";
import { computePosition, GAP } from "../../src/editor/floating-position";

const viewport = { width: 1000, height: 800 };
const widget = { width: 300, height: 160 };

describe("computePosition", () => {
	it("places the widget to the right of the anchor when there is room", () => {
		const anchor = { left: 100, right: 200, top: 300, bottom: 320 };
		const pos = computePosition(anchor, widget, viewport);
		expect(pos.placement).toBe("right");
		expect(pos.left).toBe(200 + GAP);
		expect(pos.top).toBe(300);
	});

	it("drops below the anchor when the right side does not fit", () => {
		const anchor = { left: 700, right: 800, top: 300, bottom: 320 };
		const pos = computePosition(anchor, widget, viewport);
		expect(pos.placement).toBe("below");
		expect(pos.top).toBe(320 + GAP);
	});

	it("flips above when neither the right nor below fits", () => {
		const anchor = { left: 700, right: 800, top: 700, bottom: 720 };
		const pos = computePosition(anchor, widget, viewport);
		expect(pos.placement).toBe("above");
		expect(pos.top).toBe(700 - GAP - widget.height);
	});

	it("keeps the widget inside the left edge", () => {
		const anchor = { left: 0, right: 10, top: 700, bottom: 720 };
		const pos = computePosition(anchor, { width: 300, height: 400 }, viewport);
		expect(pos.left).toBeGreaterThanOrEqual(0);
	});

	it("keeps the widget inside the right edge", () => {
		const anchor = { left: 950, right: 990, top: 300, bottom: 320 };
		const pos = computePosition(anchor, widget, viewport);
		expect(pos.left + widget.width).toBeLessThanOrEqual(viewport.width);
	});

	it("keeps the widget inside the top edge when flipped above", () => {
		// An anchor on the first visible line has almost nothing above it; the
		// widget must not be pushed off-screen where it cannot be typed into.
		const anchor = { left: 700, right: 800, top: 10, bottom: 30 };
		const pos = computePosition(anchor, { width: 300, height: 400 }, viewport);
		expect(pos.top).toBeGreaterThanOrEqual(0);
	});

	it("keeps the widget inside the bottom edge", () => {
		const anchor = { left: 100, right: 200, top: 780, bottom: 795 };
		const pos = computePosition(anchor, widget, viewport);
		expect(pos.top + widget.height).toBeLessThanOrEqual(viewport.height);
	});

	it("never returns a negative position for an anchor in the corner", () => {
		const anchor = { left: 0, right: 0, top: 0, bottom: 0 };
		const pos = computePosition(anchor, { width: 2000, height: 2000 }, viewport);
		expect(pos.left).toBeGreaterThanOrEqual(0);
		expect(pos.top).toBeGreaterThanOrEqual(0);
	});
});
