#!/usr/bin/env python3
"""Pre-commit scanner for credentials and personal data in the staged diff.

This repository ships to a public GitHub repo and its full history goes with it,
so a leak is permanent. Two classes are blocked:

  * **Secrets** — an env/key file being added, or an added line matching a known
    credential pattern.
  * **Personal data** — home directory paths, personal email addresses, local
    hostnames. Screenshots and docs written against a real vault are the likely
    source.

Escape a confirmed false positive by appending one of these to the line:

    # pragma: allowlist secret
    # pragma: allowlist personal

Placeholders (``change-me``, ``localhost``, ``${...}``, ``os.getenv`` …) are
ignored automatically for the secret patterns.

Run standalone:  python3 ops/check-secrets.py
Scan a range:    python3 ops/check-secrets.py --range origin/main..HEAD

The range form is what CI uses: a pull request has nothing staged, so a scanner
locked to the index would pass vacuously and the protection would be local-only.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

# ── Files that must never be committed ────────────────────────────────────────
BLOCKED_FILE = re.compile(r"(^|/)\.env(\.[^/]*)?$|\.pem$|(^|/)id_rsa$|\.p12$|\.pfx$")
ALLOWED_FILE = re.compile(r"\.env\.example$|\.env\.sample$")

# ── Secret value patterns ─────────────────────────────────────────────────────
SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("SonarQube token", re.compile(r"\bsq[apu]_[0-9a-f]{40}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b")),
    ("credentials in URL", re.compile(r"://[^\s:/@]+:[^\s:/@]{3,}@")),
    (
        "hardcoded secret assignment",
        re.compile(
            r"""(?ix)
            \b(secret(_?key)?|passwd|password|api[_-]?key|access[_-]?key
              |auth[_-]?token|client[_-]?secret|private[_-]?key|token)\b
            \s*[:=]\s*
            ['"][^'"\s]{8,}['"]
            """
        ),
    ),
]

# ── Personal data patterns ────────────────────────────────────────────────────
# Unlike secrets, these are NOT skipped on placeholder-looking lines: a real home
# path is often surrounded by words like "example".
PERSONAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("home directory path", re.compile(r"/home/[a-z][a-z0-9_.-]*/|/Users/[a-z][a-z0-9_.-]*/|/c/Users/[A-Za-z]")),
    ("local hostname", re.compile(r"@[a-z0-9-]+\.local\b")),
    ("email address", re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")),
]

# Addresses and paths that are safe by construction.
PERSONAL_ALLOWED = re.compile(
    r"""(?ix)
    users\.noreply\.github\.com
    | noreply@anthropic\.com
    | example\.(com|org|net)
    | git@github\.com
    | \buser@host\b
    | username[0-9]?@
    | /Users/(you|user|username)/
    """
)

# ── Lines that look like placeholders / safe references ───────────────────────
PLACEHOLDER = re.compile(
    r"""(?ix)
    change[-_\s]?me | changeme | example\b | e\.g\. | placeholder | your[-_]
    | dummy | fake | redacted | sample | \blocalhost\b | 127\.0\.0\.1
    | not[-_]?a[-_]?real | <[^>]+> | \$\{ | \{\{ | os\.getenv | os\.environ
    | getenv\( | settings\. | config\. | \bnull\b | \bnone\b
    """
)

SECRET_PRAGMA = re.compile(r"pragma:\s*allowlist secret|noqa:\s*secret", re.I)
PERSONAL_PRAGMA = re.compile(r"pragma:\s*allowlist personal", re.I)

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def _diff_args(rng: str | None) -> list[str]:
    return [rng] if rng else ["--cached"]


def blocked_files(rng: str | None) -> list[str]:
    out = _git("diff", *_diff_args(rng), "--name-only", "--diff-filter=A")
    return [p for p in out.splitlines() if BLOCKED_FILE.search(p) and not ALLOWED_FILE.search(p)]


def added_lines(rng: str | None) -> list[tuple[str, int, str]]:
    """Every added line in the diff, as (path, line number in the new file, text).

    The hunk header carries the starting line in the post-image, so a finding can
    point at a real location instead of an offset into the concatenated diff.
    """
    diff = _git("diff", *_diff_args(rng), "--unified=0")
    results: list[tuple[str, int, str]] = []
    path, lineno = "?", 0
    for raw in diff.splitlines():
        if raw.startswith("+++ b/"):
            path = raw[6:]
        elif (m := HUNK.match(raw)) is not None:
            lineno = int(m.group(1))
        elif raw.startswith("+") and not raw.startswith("+++"):
            results.append((path, lineno, raw[1:]))
            lineno += 1
    return results


def scan(rng: str | None = None) -> list[str]:
    problems: list[str] = []

    for path in blocked_files(rng):
        problems.append(f"{path}: secret file must not be committed (use .env.example)")

    for path, lineno, line in added_lines(rng):
        if ALLOWED_FILE.search(path):
            continue
        snippet = line.strip()[:100]

        if not SECRET_PRAGMA.search(line) and not PLACEHOLDER.search(line):
            for label, pat in SECRET_PATTERNS:
                if pat.search(line):
                    problems.append(f"{path}:{lineno}: possible {label} → {snippet}")
                    break

        if not PERSONAL_PRAGMA.search(line):
            stripped = PERSONAL_ALLOWED.sub("", line)
            for label, pat in PERSONAL_PATTERNS:
                if pat.search(stripped):
                    problems.append(f"{path}:{lineno}: {label} → {snippet}")
                    break

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan for secrets and personal data.")
    parser.add_argument("--range", dest="rng", help="git range to scan, e.g. origin/main..HEAD")
    args = parser.parse_args()

    try:
        problems = scan(args.rng)
    except subprocess.CalledProcessError as exc:
        # Without a range this is the pre-commit path, where "not a git context"
        # is a legitimate no-op. With one, git failing means the range never got
        # scanned — staying silent would turn the CI job into a vacuous pass,
        # which is exactly the failure this scanner exists to prevent.
        if args.rng:
            print(
                f"\n\033[31m✖ could not scan {args.rng}: git exited {exc.returncode}\033[0m\n",
                file=sys.stderr,
            )
            return 2
        return 0
    if not problems:
        return 0
    where = f"in {args.rng}" if args.rng else "in the staged diff"
    print(f"\n\033[31m✖ secrets or personal data {where}\033[0m\n", file=sys.stderr)
    for p in problems:
        print(f"   • {p}", file=sys.stderr)
    print(
        "\n   Redact it, or append to the line:\n"
        "     # pragma: allowlist secret     (confirmed false positive, credential pattern)\n"
        "     # pragma: allowlist personal   (confirmed false positive, personal data)\n"
        "   Bypassing the hook (not recommended): git commit --no-verify\n",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
