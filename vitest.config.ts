import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
	"src/ui/confirm-modal.ts",
	"src/ui/thread-card.ts",
	"src/ui/thread-popover.ts",
];

export default defineConfig({
	resolve: {
		alias: {
			// The obsidian package is types-only and has no runtime, so anything in
			// src/ importing it would fail to resolve under vitest.
			obsidian: fileURLToPath(new URL("./tests/helpers/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// The E2E suite launches a real Obsidian, which CI has no way to provide.
		// It has its own config and script; without this exclusion `npm test`
		// picks it up and fails the runner with ENOENT.
		exclude: ["tests/e2e/**"],
		coverage: {
			provider: "v8",
			// Every source file, not only the ones a test imports: a module nobody tests
			// has to lower the number rather than vanish from it.
			include: ["src/**/*.ts"],
			exclude: OBSIDIAN_BOUND_FILES,
			// lcov feeds SonarQube (#253); json-summary feeds the README badge (#256).
			reporter: ["text-summary", "lcov", "json-summary"],
			reportsDirectory: "coverage",
			// About a point under what was measured when these were set (lines 98.13,
			// statements 97.08, functions 95.39, branches 92.71), so a change that lowers
			// coverage fails CI. Raise them when coverage rises; never lower them to pass.
			thresholds: {
				lines: 97,
				statements: 96,
				functions: 94,
				branches: 91,
			},
		},
	},
});
