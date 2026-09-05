import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
	{
		ignores: ["main.js", "node_modules/**", "coverage/**"],
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
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
