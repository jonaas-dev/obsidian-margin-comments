import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce, type Timers } from "../../src/debounce";

/**
 * The timers the plugin passes, standing in for a window's.
 *
 * `globalThis` and not `window`: vitest's fake timers patch the global pair, and
 * this suite runs in node, where there is no `window` at all. That is the reason
 * the source takes these as an argument rather than reaching for one (#336).
 */
const timers: Timers = {
	setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout) as unknown as number,
	clearTimeout: (id) => globalThis.clearTimeout(id),
};

describe("debounce", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not run before the delay is up", () => {
		const work = vi.fn();
		debounce(work, 300, timers)();
		vi.advanceTimersByTime(299);
		expect(work).not.toHaveBeenCalled();
	});

	it("runs once after the delay", () => {
		const work = vi.fn();
		debounce(work, 300, timers)();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(1);
	});

	it("collapses a burst into a single run", () => {
		// The whole point: a hundred keystrokes must cost one pass, not a hundred.
		const work = vi.fn();
		const trigger = debounce(work, 300, timers);
		for (let i = 0; i < 100; i++) {
			trigger();
			vi.advanceTimersByTime(10);
		}
		expect(work).not.toHaveBeenCalled();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(1);
	});

	it("runs again for a burst that comes after the first has landed", () => {
		const work = vi.fn();
		const trigger = debounce(work, 300, timers);
		trigger();
		vi.advanceTimersByTime(300);
		trigger();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(2);
	});

	it("drops a pending run when cancelled", () => {
		const work = vi.fn();
		const trigger = debounce(work, 300, timers);
		trigger();
		trigger.cancel();
		vi.advanceTimersByTime(1000);
		expect(work).not.toHaveBeenCalled();
	});

	it("cancels nothing when there is nothing pending", () => {
		const work = vi.fn();
		const trigger = debounce(work, 300, timers);
		trigger.cancel();
		trigger();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(1);
	});
});
