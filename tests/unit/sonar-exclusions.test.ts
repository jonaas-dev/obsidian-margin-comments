import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import coverageConfig from "../../vitest.coverage.config";

/**
 * The Obsidian-bound files are listed twice: once for vitest's coverage run and once
 * for SonarQube, which reads a static properties file and cannot import the config.
 * A list repeated in two places drifts — it already had, by `src/types.ts` — and the
 * drift is invisible: Sonar simply reports a different number from CI's.
 */
describe("SonarQube coverage exclusions", () => {
	const fromVitest = coverageConfig.test?.coverage?.exclude ?? [];

	const fromSonar = (() => {
		const properties = readFileSync("sonar-project.properties", "utf8");
		// Continued over lines with a trailing backslash, as .properties files allow.
		const unwrapped = properties.replace(/\\\r?\n\s*/g, "");
		const line = unwrapped
			.split(/\r?\n/)
			.find((l) => l.startsWith("sonar.coverage.exclusions="));
		if (!line) throw new Error("sonar.coverage.exclusions is not set");
		return line
			.slice("sonar.coverage.exclusions=".length)
			.split(",")
			.map((p) => p.trim());
	})();

	it("lists the same files as the coverage config", () => {
		expect([...fromSonar].sort()).toEqual([...fromVitest].sort());
	});

	it("names files that exist", () => {
		for (const path of fromSonar) expect(() => readFileSync(path, "utf8")).not.toThrow();
	});
});
