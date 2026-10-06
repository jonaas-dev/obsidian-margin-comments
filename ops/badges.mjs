#!/usr/bin/env node
/**
 * Writes the measured unit coverage into the README badge, or checks it.
 *
 * A badge typed by hand goes stale without anyone noticing — a thing that looks
 * green and proves nothing, which is the failure AGENTS.md is about. The number
 * comes from coverage/coverage-summary.json, written by `npm run test:coverage`,
 * and CI runs this with --check straight afterwards so a README that disagrees
 * with the measurement fails the build (#256).
 *
 * A static badge rather than a gist or a published JSON endpoint: it needs no
 * token, and it adds no bot commits to a history that goes public under strict
 * author rules (#178). Worth revisiting at 1.0, when the repository is public
 * and SonarCloud or Codecov become options (#257).
 */
import { readFileSync, writeFileSync } from "node:fs";

const README = "README.md";
const SUMMARY = "coverage/coverage-summary.json";
const ALT = "unit coverage";
// The badge is matched by its alt text, so moving it in the row does not break this.
const BADGE = /<img alt="unit coverage[^"]*" src="https:\/\/img\.shields\.io\/badge\/[^"]*">/;
// Rounding only. A real change in coverage is far larger than this, and a
// tighter bound would fail on the last digit for no reason.
const TOLERANCE = 0.5;

/** Shields' own thresholds, so the colour means the same here as everywhere else. */
function colour(pct) {
	if (pct >= 95) return "brightgreen";
	if (pct >= 90) return "green";
	if (pct >= 75) return "yellowgreen";
	if (pct >= 60) return "yellow";
	return "red";
}

function measured() {
	let summary;
	try {
		summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
	} catch {
		console.error(`✖ badges: ${SUMMARY} is missing. Run npm run test:coverage first.`);
		process.exit(1);
	}
	const pct = summary?.total?.lines?.pct;
	if (typeof pct !== "number") {
		console.error(`✖ badges: ${SUMMARY} has no total.lines.pct.`);
		process.exit(1);
	}
	return pct;
}

const pct = measured();
const shown = pct.toFixed(1);
const badge = `<img alt="${ALT} ${shown}%" src="https://img.shields.io/badge/${encodeURIComponent(ALT)}-${encodeURIComponent(`${shown}%`)}-${colour(pct)}">`;

const readme = readFileSync(README, "utf8");
const current = readme.match(BADGE)?.[0];

if (process.argv.includes("--check")) {
	if (current === undefined) {
		console.error(`✖ badges: no "${ALT}" badge in ${README}. Run npm run badges.`);
		process.exit(1);
	}
	const written = Number(current.match(/alt="unit coverage ([\d.]+)%"/)?.[1]);
	if (!Number.isFinite(written) || Math.abs(written - pct) > TOLERANCE) {
		console.error(
			`✖ badges: ${README} says ${written}% unit coverage, the suite measured ${shown}%.\n` +
				`  Run npm run badges and commit the change.`,
		);
		process.exit(1);
	}
	console.log(`✓ badges: README agrees with the measured ${shown}% unit coverage.`);
	process.exit(0);
}

if (current === undefined) {
	console.error(`✖ badges: no "${ALT}" badge in ${README} to update.`);
	process.exit(1);
}
writeFileSync(README, readme.replace(BADGE, badge));
console.log(`✓ badges: unit coverage ${shown}%.`);
