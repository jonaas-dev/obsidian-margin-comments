import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Files that only run inside Obsidian: workspace, DOM and CodeMirror wiring that no
 * unit test reaches without faking the app. The E2E suite covers them against a real
 * Obsidian, which CI cannot run, so counting them would make the unit coverage number
 * describe the E2E suite instead (#252).
 *
 * Listed one by one rather than by pattern, so a new module is measured by default.
 */
const OBSIDIAN_BOUND_FILES = [
	"src/main.ts",
	"src/navigation.ts",
	"src/settings.ts",
	"src/vault-events.ts",
	"src/editor/bottom-sheet.ts",
	"src/editor/floating-comment.ts",
	"src/editor/hover-gutter.ts",
	"src/editor/thread-routing.ts",
	"src/reading/reading-marks.ts",
	"src/reading/reading-mode.ts",
	"src/ui/comment-panel.ts",
	"src/ui/render-comment-body.ts",
	"src/ui/confirm-modal.ts",
	"src/ui/thread-card.ts",
	"src/ui/thread-popover.ts",
];

/**
 * The unit suite with coverage, as `npm run test:coverage` and CI run it.
 *
 * A config of its own rather than `--coverage` on the plain one, because the timing
 * budgets have to know that they are instrumented: see tests/helpers/timing-budget.ts.
 */
export default mergeConfig(
	base,
	defineConfig({
		test: {
			env: { MEASURING_COVERAGE: "1" },
			// The budgets stand down under instrumentation (tests/helpers/timing-budget.ts),
			// but vitest's own clock does not, and the default 5000 ms is not a margin:
			// the fuzzy re-anchoring case measured 4561 ms on one CI run and 5783 ms on
			// the next, with no change to the code between them (#284). Long enough that
			// only a test that has genuinely stopped hits it; the real budgets are proved
			// by `npm test`, which keeps the default.
			testTimeout: 60_000,
			coverage: {
				enabled: true,
				provider: "v8",
				// Every source file, not only the ones a test imports: a module nobody
				// tests has to lower the number rather than vanish from it.
				include: ["src/**/*.ts"],
				exclude: OBSIDIAN_BOUND_FILES,
				// lcov feeds SonarQube (#253); json-summary feeds the README badge (#256).
				reporter: ["text-summary", "lcov", "json-summary"],
				reportsDirectory: "coverage",
				// About a point under what was measured when these were set (lines 98.13,
				// statements 97.08, functions 95.39, branches 92.71), so a change that
				// lowers coverage fails CI. Raise them when coverage rises; never lower
				// them to pass.
				thresholds: {
					lines: 97,
					statements: 96,
					functions: 94,
					branches: 91,
				},
			},
		},
	}),
);
