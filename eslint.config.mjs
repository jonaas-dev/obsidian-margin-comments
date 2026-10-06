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
