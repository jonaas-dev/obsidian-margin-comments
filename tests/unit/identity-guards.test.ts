import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Both identity guards run against a throwaway repository, so each case exercises the
// real hook and the real script rather than a description of them. The case #251 was
// filed for is the second one in each block: a real-looking name and inbox, which the
// old guards let through because they decided from the commit's own identity.

const MAINTAINER = "jonaas-dev";
const NOREPLY = "100514206+jonaas-dev@users.noreply.github.com";
const REAL = { name: "Jane Doe", email: "jane.doe@example.com" };

// Isolated from the machine's git configuration, which could otherwise supply an
// identity or a hooks.* setting and decide the outcome.
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let repo: string;

function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function identity(name: string, email: string): void {
	git("config", "user.name", name);
	git("config", "user.email", email);
}

function commit(file: string): string {
	writeFileSync(join(repo, file), `${file}\n`);
	git("add", file);
	git("commit", "-q", "--no-verify", "-m", file);
	return git("rev-parse", "HEAD");
}

function run(command: string, args: string[]): number {
	return spawnSync(command, args, { cwd: repo, env, encoding: "utf8" }).status ?? -1;
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "identity-guards-"));
	git("init", "-q");
	mkdirSync(join(repo, "ops"));
	mkdirSync(join(repo, ".githooks"));
	for (const file of ["ops/check-secrets.py", "ops/check-identity.py", ".githooks/pre-commit"]) {
		copyFileSync(resolve(file), join(repo, file));
	}
	identity(MAINTAINER, NOREPLY);
	commit("base.txt");
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("pre-commit hook", () => {
	function hook(): number {
		writeFileSync(join(repo, "change.txt"), "change\n");
		git("add", "change.txt");
		return run("sh", [".githooks/pre-commit"]);
	}

	it("accepts the maintainer identity in the maintainer's clone", () => {
		git("config", "hooks.maintainer", "true");
		expect(hook()).toBe(0);
	});

	it("rejects a real name and inbox in the maintainer's clone", () => {
		git("config", "hooks.maintainer", "true");
		identity(REAL.name, REAL.email);
		expect(hook()).toBe(1);
	});

	it("rejects the maintainer's name with another address", () => {
		identity(MAINTAINER, REAL.email);
		expect(hook()).toBe(1);
	});

	it("lets an outside contributor commit under their own identity", () => {
		identity(REAL.name, REAL.email);
		expect(hook()).toBe(0);
	});
});

describe("check-identity.py", () => {
	function check(range: string, mode: string[]): number {
		return run("python3", [
			"ops/check-identity.py",
			"--range",
			range,
			"--maintainer",
			MAINTAINER,
			...mode,
		]);
	}

	/**
	 * The tip of history that actually gets published, from wherever this runs.
	 *
	 * On a pull_request checkout, HEAD is the synthetic merge actions/checkout
	 * builds, authored under the pull request author's GitHub profile name — a
	 * commit that is never pushed anywhere and that this guard has no business
	 * judging. The pull request's own head is its second parent. The first parent
	 * is the base branch, already checked by the push that landed it.
	 */
	function publishedTip(): string {
		const out = spawnSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
			cwd: resolve("."),
			env,
			encoding: "utf8",
		}).stdout.trim();
		const parents = out.split(/\s+/).length - 1;
		return parents === 2 && process.env.GITHUB_ACTIONS === "true" ? "HEAD^2" : "HEAD";
	}

	/** Rewrite ACCEPTED in the copied script, to exercise the allowlist on a real sha. */
	function accept(sha: string): string {
		const script = join(repo, "ops/check-identity.py");
		const source = readFileSync(script, "utf8");
		const replaced = source.replace(
			/^ACCEPTED = \{$[\s\S]*?^\}$/m,
			`ACCEPTED = {${JSON.stringify(sha)}: "accepted by the test"}`,
		);
		expect(replaced).not.toBe(source);
		writeFileSync(script, replaced);
		return sha;
	}

	function associations(table: Record<string, string[]>): string[] {
		const file = join(repo, "associations.json");
		writeFileSync(file, JSON.stringify(table));
		return ["--associations", file];
	}

	it("passes the maintainer's pull request made under the maintainer identity", () => {
		const base = git("rev-parse", "HEAD");
		commit("a.txt");
		expect(check(`${base}..HEAD`, ["--opener", MAINTAINER])).toBe(0);
	});

	it("fails the maintainer's pull request carrying a real name and inbox", () => {
		const base = git("rev-parse", "HEAD");
		identity(REAL.name, REAL.email);
		commit("a.txt");
		expect(check(`${base}..HEAD`, ["--opener", MAINTAINER])).toBe(1);
	});

	it("fails a noreply address under a real name", () => {
		const base = git("rev-parse", "HEAD");
		identity(REAL.name, NOREPLY);
		commit("a.txt");
		expect(check(`${base}..HEAD`, ["--opener", MAINTAINER])).toBe(1);
	});

	it("exempts a pull request an outside contributor opened", () => {
		const base = git("rev-parse", "HEAD");
		identity(REAL.name, REAL.email);
		commit("a.txt");
		expect(check(`${base}..HEAD`, ["--opener", "someone-else"])).toBe(0);
	});

	it("fails a pushed commit that no pull request carries", () => {
		const base = git("rev-parse", "HEAD");
		identity(REAL.name, REAL.email);
		commit("a.txt");
		expect(check(`${base}..HEAD`, associations({}))).toBe(1);
	});

	it("fails a pushed commit from the maintainer's own pull request", () => {
		const base = git("rev-parse", "HEAD");
		identity(REAL.name, REAL.email);
		const sha = commit("a.txt");
		expect(check(`${base}..HEAD`, associations({ [sha]: [MAINTAINER] }))).toBe(1);
	});

	it("exempts a pushed commit from an outside contributor's pull request", () => {
		const base = git("rev-parse", "HEAD");
		identity(REAL.name, REAL.email);
		const sha = commit("a.txt");
		expect(check(`${base}..HEAD`, associations({ [sha]: ["someone-else"] }))).toBe(0);
	});

	it("reports an error, not a pass, when the range cannot be read", () => {
		expect(check("0000000..HEAD", ["--opener", MAINTAINER])).toBe(2);
	});

	// #307: a push whose base was rewritten away cannot say which commits it added,
	// so the whole history is scanned instead. These two exemptions are what make
	// that scan report defects rather than the project's own accepted past.
	describe("scanning a whole history", () => {
		const BOT = "dependabot[bot]";
		const BOT_NOREPLY = "49699333+dependabot[bot]@users.noreply.github.com";

		it("exempts a bot's own commit with no pull request behind it", () => {
			const base = git("rev-parse", "HEAD");
			identity(BOT, BOT_NOREPLY);
			commit("a.txt");
			// associations({}) is the case that used to fail: GitHub drops the
			// association when a pull request lands by fast-forward push.
			expect(check(`${base}..HEAD`, associations({}))).toBe(0);
		});

		it("still checks a commit wearing a bot name over somebody's inbox", () => {
			const base = git("rev-parse", "HEAD");
			identity(BOT, REAL.email);
			commit("a.txt");
			expect(check(`${base}..HEAD`, associations({}))).toBe(1);
		});

		it("does not take a bot name as cover for another bot's address", () => {
			const base = git("rev-parse", "HEAD");
			identity("renovate[bot]", BOT_NOREPLY);
			commit("a.txt");
			expect(check(`${base}..HEAD`, associations({}))).toBe(1);
		});

		it("exempts a commit named in the accepted list", () => {
			const base = git("rev-parse", "HEAD");
			identity(REAL.name, NOREPLY);
			const sha = accept(commit("a.txt"));
			expect(sha).toHaveLength(40);
			expect(check(`${base}..HEAD`, associations({}))).toBe(0);
		});

		it("checks a commit the accepted list does not name", () => {
			const base = git("rev-parse", "HEAD");
			identity(REAL.name, NOREPLY);
			accept("0".repeat(40));
			commit("a.txt");
			expect(check(`${base}..HEAD`, associations({}))).toBe(1);
		});

		it("passes over this repository's own history on the exemptions alone", () => {
			// The scan the workflow falls back to, against the real history rather
			// than a fixture. The association table is empty on purpose: with no
			// pull request able to exempt anything, a pass means ACCEPTED and the
			// bot rule cover every commit here by themselves. A future commit that
			// would break the fallback fails this instead of failing in CI after a
			// rewrite, which is the moment nobody wants to debug it.
			const table = join(repo, "empty.json");
			writeFileSync(table, "{}");
			const result = spawnSync(
				"python3",
				[
					"ops/check-identity.py",
					"--range",
					publishedTip(),
					"--maintainer",
					MAINTAINER,
					"--associations",
					table,
				],
				{ cwd: resolve("."), env, encoding: "utf8" },
			);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		});
	});
});
