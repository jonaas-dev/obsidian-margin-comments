import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../../src/debounce";

describe("debounce", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not run before the delay is up", () => {
		const work = vi.fn();
		debounce(work, 300)();
		vi.advanceTimersByTime(299);
		expect(work).not.toHaveBeenCalled();
	});

	it("runs once after the delay", () => {
		const work = vi.fn();
		debounce(work, 300)();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(1);
	});

	it("collapses a burst into a single run", () => {
		// The whole point: a hundred keystrokes must cost one pass, not a hundred.
		const work = vi.fn();
		const trigger = debounce(work, 300);
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
		const trigger = debounce(work, 300);
		trigger();
		vi.advanceTimersByTime(300);
		trigger();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(2);
	});

	it("drops a pending run when cancelled", () => {
		const work = vi.fn();
		const trigger = debounce(work, 300);
		trigger();
		trigger.cancel();
		vi.advanceTimersByTime(1000);
		expect(work).not.toHaveBeenCalled();
	});

	it("cancels nothing when there is nothing pending", () => {
		const work = vi.fn();
		const trigger = debounce(work, 300);
		trigger.cancel();
		trigger();
		vi.advanceTimersByTime(300);
		expect(work).toHaveBeenCalledTimes(1);
	});
});
