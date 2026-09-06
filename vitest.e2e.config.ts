import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/e2e/**/*.test.ts"],
		// One Obsidian instance at a time: they contend for the debugging port.
		fileParallelism: false,
		testTimeout: 60000,
		hookTimeout: 180000,
	},
});
