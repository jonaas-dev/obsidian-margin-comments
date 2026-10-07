import js from "@eslint/js";
import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * Obsidian's own plugin, scoped to the shipped source.
 *
 * ObsidianReviewBot scans submissions to the community directory with it and its
 * findings hold the review, so a green `npm run lint` that does not run it is
 * green about the wrong thing (#249). Some of its rules cannot be silenced with
 * a directive comment, which is another reason to see them here rather than in
 * a review.
 *
 * Only `src/`: the recommended set turns on typescript-eslint's type-checked
 * rules, and the tests are full of deliberate `any` for faking Obsidian. The
 * plugin is about plugin code, which is what src/ is.
 */
const obsidianmdForSource = obsidianmd.configs.recommended.map((config) => ({
	...config,
	ignores: [...(config.ignores ?? []), "tests/**", "ops/**", "*.mjs", "*.config.ts"],
}));

export default [
	{
		ignores: ["main.js", "node_modules/**", "coverage/**"],
	},
	...obsidianmdForSource,
	{
		files: ["src/**/*.ts"],
		// Type-aware parsing: no-floating-promises and unbound-method, the two
		// that found real things here, cannot see anything without it.
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			// A warning here was worth nothing: `npm run lint` exits 0 on warnings,
			// so an `import "node:fs"` in src/ passed both lint and typecheck when
			// the audit of 2026-10-07 tried it. manifest.json says
			// isDesktopOnly: false, esbuild marks the builtins external rather than
			// failing, and tsconfig's types: ["node"] makes them typecheck — so the
			// first sign would have been a crash on a phone nobody runs in CI.
			"obsidianmd/no-nodejs-modules": "error",
		},
	},
	{
		// Three rules that are wrong in these particular places. They are turned off
		// here rather than at the call site because obsidianmd's own config forbids
		// silencing them inline (eslint-comments/no-restricted-disable), and they are
		// scoped to the files concerned so the rule keeps working everywhere else.
		//
		// `prefer-create-el` in render-comment-body: the suggestion goes through
		// `.win`, and this document is deliberately one with no browsing context —
		// which is the entire reason nothing in it fetches. The `<a>` already uses the
		// element's own document, which is what the rule is for.
		//
		// `prefer-create-el` in hover-gutter and reading-marks: `createSpan()` reads
		// the same global `document`, so the suggestion changes nothing. The node is
		// adopted when CodeMirror or the post-processor inserts it, and the popout case
		// is asserted end to end (#236).
		//
		// `prefer-instanceof` in reading-marks: measured backwards in this process —
		// `instanceofMain` true, `instanceofOwn` false — so `.instanceOf()` would reject
		// the elements the walk exists to find (#249).
		files: [
			"src/ui/render-comment-body.ts",
			"src/editor/hover-gutter.ts",
			"src/reading/reading-marks.ts",
		],
		rules: {
			"obsidianmd/prefer-create-el": "off",
			"obsidianmd/prefer-instanceof": "off",
		},
	},
	{
		// `prefer-window-timers` guards against a timer belonging to the wrong window.
		// This debounce is constructed once, by the plugin instance, in the main
		// window, and never from a popout — so the bare timers are the right ones.
		//
		// Reaching for `window` here was tried on 2026-10-07 and reverted: it took the
		// module's reason to exist with it. Its docblock says it is hand-rolled rather
		// than Obsidian's so the delay can be tested with fake timers without standing
		// up the plugin, and the unit suite runs in node, where there is no `window`.
		// Six tests went red.
		files: ["src/debounce.ts"],
		rules: { "obsidianmd/prefer-window-timers": "off" },
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
			// Obsidian plugins run inside Electron's renderer, so the browser
			// globals are the right set: console, document, setTimeout, HTMLElement.
			globals: { ...globals.browser },
		},
		plugins: { "@typescript-eslint": tseslint },
		rules: {
			// Spreading only the typescript-eslint rules drops the JavaScript
			// base set, leaving no-fallthrough, no-dupe-keys, no-unreachable and
			// friends switched off.
			...js.configs.recommended.rules,
			...tseslint.configs.recommended.rules,
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			// Shipped code must be quiet; the pre-release audit checks for this too.
			"no-console": ["error", { allow: ["warn", "error"] }],
			eqeqeq: ["error", "smart"],
		},
	},
];
