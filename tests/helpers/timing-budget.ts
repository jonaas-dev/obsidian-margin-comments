import process from "node:process";

/**
 * A timing budget in milliseconds, or none at all while coverage is being measured.
 *
 * V8 coverage instruments the hot loops these budgets time. On CI it took the fuzzy
 * re-anchoring case to 2894 and 3760 ms against a 2000 ms budget (#252), so a budget
 * checked there fails on the instrumentation, not on the code. Speed is proved by
 * `npm test`, which runs the same budgets uninstrumented; CI runs both.
 *
 * Only the timing assertion is lifted: everything else in those tests still runs
 * under coverage.
 */
export function budget(ms: number): number {
	return process.env.MEASURING_COVERAGE ? Number.POSITIVE_INFINITY : ms;
}
