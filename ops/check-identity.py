#!/usr/bin/env python3
"""Refuses maintainer commits that would publish a real name or a personal inbox.

This repository goes public with its whole history, so a commit carrying the
maintainer's real identity is permanent once it lands.

Which commits count as the maintainer's is decided by who opened the pull request
they belong to, never by the commit's own name or address. Keying on the commit
identity exempted exactly the commit this guard exists for: one made from a machine
whose global git identity is the maintainer's real name and inbox (#251).

  * Pull request: every commit in the range is checked when the maintainer opened it.
    Anyone else's pull request is exempt, so outside contributors keep whatever
    identity GitHub has on file.
  * Push: each commit is checked unless a pull request opened by someone else carries
    it. A commit that never went through a pull request is the pusher's, and is checked.

A maintainer commit passes when its author is the maintainer, its committer is the
maintainer or GitHub, and both addresses are GitHub noreply addresses.

Pull request:  python3 ops/check-identity.py --range BASE..HEAD --maintainer LOGIN --opener LOGIN
Push:          python3 ops/check-identity.py --range BEFORE..AFTER --maintainer LOGIN --repo OWNER/NAME
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable

NOREPLY = re.compile(
    r"^(\d+\+)?[A-Za-z0-9-]+(\[bot\])?@users\.noreply\.github\.com$|^noreply@github\.com$"
)
# The committer GitHub writes when it creates or signs a commit itself.
GITHUB_COMMITTER = "GitHub"

FIELD = "\x1f"


class ScanError(Exception):
    pass


def _run(*args: str) -> str:
    try:
        return subprocess.run(
            list(args), capture_output=True, text=True, check=True
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise ScanError(f"{' '.join(args[:3])} failed: {exc}") from exc


def commits(rng: str) -> list[dict[str, str]]:
    out = _run(
        "git", "log", f"--format=%H{FIELD}%an{FIELD}%ae{FIELD}%cn{FIELD}%ce", rng
    )
    result = []
    for line in out.splitlines():
        sha, an, ae, cn, ce = line.split(FIELD)
        result.append({"sha": sha, "an": an, "ae": ae, "cn": cn, "ce": ce})
    return result


def openers_from_github(repo: str, sha: str) -> list[str]:
    out = _run(
        "gh", "api", f"repos/{repo}/commits/{sha}/pulls", "--jq", "[.[].user.login]"
    )
    return json.loads(out or "[]")


def problems_in(commit: dict[str, str], maintainer: str) -> list[str]:
    short = commit["sha"][:7]
    found = []
    if commit["an"] != maintainer:
        found.append(
            f"{short}: author name is '{commit['an']}', expected '{maintainer}'"
        )
    if commit["cn"] not in (maintainer, GITHUB_COMMITTER):
        found.append(
            f"{short}: committer name is '{commit['cn']}', expected '{maintainer}'"
        )
    for role, address in (("author", commit["ae"]), ("committer", commit["ce"])):
        if not NOREPLY.search(address):
            found.append(
                f"{short}: {role} address '{address}' is not a GitHub noreply address"
            )
    return found


def scan(
    rng: str,
    maintainer: str,
    opener: str | None,
    openers_of: Callable[[str], list[str]],
) -> list[str]:
    found: list[str] = []
    for commit in commits(rng):
        if opener is not None:
            if opener != maintainer:
                continue
        else:
            others = [
                login for login in openers_of(commit["sha"]) if login != maintainer
            ]
            if others:
                continue
        found.extend(problems_in(commit, maintainer))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="Check maintainer commit identities.")
    parser.add_argument(
        "--range", dest="rng", required=True, help="git range, e.g. BASE..HEAD"
    )
    parser.add_argument(
        "--maintainer", required=True, help="the maintainer's GitHub login"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--opener", help="login that opened the pull request being checked"
    )
    mode.add_argument(
        "--repo", help="OWNER/NAME, to look up the pull requests of pushed commits"
    )
    mode.add_argument(
        "--associations",
        help="JSON file mapping commit sha to pull request openers, in place of --repo",
    )
    args = parser.parse_args()

    if args.associations:
        with open(args.associations, encoding="utf-8") as handle:
            table: dict[str, list[str]] = json.load(handle)

        def openers_of(sha: str) -> list[str]:
            return table.get(sha, [])

    else:

        def openers_of(sha: str) -> list[str]:
            return openers_from_github(args.repo, sha)

    if args.opener is not None and args.opener != args.maintainer:
        print(
            f"Opened by {args.opener}: identity checks apply to the maintainer's pull requests only."
        )

    try:
        found = scan(args.rng, args.maintainer, args.opener, openers_of)
    except ScanError as exc:
        # A range or lookup that could not be read was never checked, and saying
        # nothing would make this a vacuous pass.
        print(
            f"\n\033[31m✖ could not check {args.rng}: {exc}\033[0m\n", file=sys.stderr
        )
        return 2

    if not found:
        return 0
    print(
        "\n\033[31m✖ maintainer commits carry an identity that would be published\033[0m\n",
        file=sys.stderr,
    )
    for problem in found:
        print(f"   • {problem}", file=sys.stderr)
    print(
        f"\n   Rewrite them as {args.maintainer} with the GitHub noreply address before merging.\n",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
