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

Two exemptions make the scan usable over a whole history, which is what a push whose
base has been rewritten away leaves it with (#307):

  * A bot's own commit, authored under a GitHub App identity. This does not go through
    the pull request lookup, which drops the association when a pull request lands by
    fast-forward push -- the way this repository merges -- so the exemption that was
    meant to cover dependabot silently did not.
  * Commits named in ACCEPTED below: history the project has looked at and kept.

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

BOT_NAME = re.compile(r"^[A-Za-z0-9-]+\[bot\]$")

# History this project has examined and decided to keep, by sha and by reason.
#
# A sha is the honest identifier for "this commit, the one we looked at", and it
# fails in the safe direction: rewrite the history and these stop resolving, so the
# commits that replace them are checked again rather than inheriting an exemption
# nobody re-examined.
ACCEPTED = {
    "7b0f574cbb2501a6a9d680cf45430c9f577d4fac": (
        "merge commit of 2026-09-13 under the maintainer's real display name; "
        "the address was always the GitHub noreply alias and the public profile "
        "publishes the name already (#178, closed as won't fix)"
    ),
    "16f6a34ac83e51ee0f3e7aaa0681d5510f6449a0": (
        "merge commit of 2026-09-13 under the maintainer's real display name; "
        "see 7b0f574 (#178)"
    ),
}

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


def is_bot(commit: dict[str, str]) -> bool:
    """Whether a commit is a GitHub App's own, by its identity rather than its origin.

    The name and the address have to agree: a bot's noreply address embeds the same
    `name[bot]`, so a commit claiming to be dependabot from somewhere else fails the
    address half and stays checked. And a name nobody else can claim, paired with a
    GitHub noreply address, publishes no personal identity either way -- which is the
    only thing this guard is protecting.
    """
    name, address = commit["an"], commit["ae"]
    if not BOT_NAME.match(name):
        return False
    return re.fullmatch(rf"\d+\+{re.escape(name)}@users\.noreply\.github\.com", address) is not None


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
        if commit["sha"] in ACCEPTED or is_bot(commit):
            continue
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
