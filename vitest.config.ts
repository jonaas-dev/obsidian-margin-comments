import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
	},
});
