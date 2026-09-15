import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		return run("python3", ["ops/check-identity.py", "--range", range, "--maintainer", MAINTAINER, ...mode]);
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
});
