#!/usr/bin/env python3
"""Deterministic audit of code comments.

Detects and (optionally) removes comments that add no value:
  - divider  : separators/rules (----, ====, ####, ****, ////, ~~~~ ...)
  - banner   : ASCII-art / box-drawing boxes
  - empty    : empty comments (just the marker)
  - code     : commented-out code (per-language heuristic)

It only REPORTS `code` and TODO/FIXME (manual review). With --fix it removes
only the unambiguous categories: divider, banner, empty.

The WHY-vs-WHAT distinction is NOT deterministic and is not decided here: this
script cleans the mechanical noise; the "explains the why" judgement is the skill's.

Usage:
  python3 audit_comments.py [PATHS...] [--fix] [--json]
  (without PATHS it uses the text files tracked by git)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

LINE_MARKERS = {
    ".py": "#", ".sh": "#", ".bash": "#", ".zsh": "#", ".rb": "#",
    ".yaml": "#", ".yml": "#", ".toml": "#", ".ini": "#", ".cfg": "#",
    ".ts": "//", ".tsx": "//", ".js": "//", ".jsx": "//", ".mjs": "//",
    ".java": "//", ".c": "//", ".h": "//", ".cpp": "//", ".hpp": "//",
    ".go": "//", ".rs": "//", ".swift": "//", ".kt": "//", ".scss": "//",
    ".sql": "--", ".lua": "--",
    # Block comments only (/* */, <!-- -->): there is no line marker to audit.
    ".css": None,
    ".html": None, ".htm": None,
}
SKIP_DIRS = {
    "node_modules", ".venv", "venv", "dist", "build", ".git", ".angular",
    "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", "coverage",
    "htmlcov", ".code-review-graph", "playwright-report", "test-results",
}

DIVIDER_RE = re.compile(r"^[\s\-=#*/~_.<>+·—–■□●○=]{3,}$")
CODE_HINTS = [
    re.compile(r";\s*$"),                                 # a trailing ; is rare in prose
    re.compile(r"^\s*[}\])]+\s*;?\s*$"),
    re.compile(r"^\s*(def|class|import|from|return|if|elif|else|for|while|try|except|with|async|await|raise|yield)\b"),
    re.compile(r"^\s*(const|let|var|function|public|private|protected|export|import|new|throw|switch|case)\b"),
    re.compile(r"^\s*[\w.\[\]'\"]+\s*=\s*[^=]"),
    re.compile(r"^\s*[\w.]+\s*\([^)]*\)\s*[;{]?\s*$"),
    re.compile(r"=>"),
    re.compile(r"</?[a-zA-Z][\w-]*[\s/>]"),
]
TODO_RE = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")


def git_tracked_files() -> list[str]:
    try:
        out = subprocess.check_output(["git", "ls-files"], text=True)
        return [f for f in out.splitlines() if os.path.splitext(f)[1] in LINE_MARKERS]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []


def iter_files(paths: list[str]):
    for p in paths:
        if os.path.isfile(p):
            yield p
        elif os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for f in files:
                    if os.path.splitext(f)[1] in LINE_MARKERS:
                        yield os.path.join(root, f)


def classify(content: str) -> str | None:
    """Classify a comment's text (marker already stripped); return its category or None."""
    stripped = content.strip()
    if stripped == "":
        return "empty"
    if DIVIDER_RE.match(stripped):
        return "divider"
    non_alpha = sum(1 for c in stripped if not c.isalnum() and not c.isspace())
    if len(stripped) >= 6 and non_alpha / len(stripped) > 0.6:
        return "banner"
    if TODO_RE.search(stripped):
        return "todo"
    for rx in CODE_HINTS:
        if rx.search(stripped):
            return "code"
    return None


def audit_file(path: str):
    ext = os.path.splitext(path)[1]
    marker = LINE_MARKERS.get(ext)
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except (UnicodeDecodeError, OSError):
        return [], None
    findings = []
    keep = [True] * len(lines)
    for i, line in enumerate(lines):
        stripped = line.strip()
        content = None
        if marker and stripped.startswith(marker):
            content = stripped[len(marker):]
        elif marker == "--" and stripped.startswith("--"):
            content = stripped[2:]
        if content is None:
            continue
        cat = classify(content)
        if cat:
            findings.append({"line": i + 1, "cat": cat, "text": line})
            if cat in ("divider", "banner", "empty"):
                keep[i] = False
    new_lines = [line for line, k in zip(lines, keep) if k]
    return findings, new_lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--fix", action="store_true", help="remove divider/banner/empty (the unambiguous categories)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    paths = list(iter_files(args.paths)) if args.paths else git_tracked_files()
    all_findings = {}
    fixed = 0
    for f in paths:
        findings, new_lines = audit_file(f)
        if not findings:
            continue
        all_findings[f] = findings
        if args.fix and new_lines is not None:
            removed = sum(1 for x in findings if x["cat"] in ("divider", "banner", "empty"))
            if removed:
                with open(f, "w", encoding="utf-8") as fh:
                    fh.write("\n".join(new_lines) + "\n")
                fixed += removed

    if args.json:
        print(json.dumps(all_findings, ensure_ascii=False, indent=2))
        return 0

    totals = {}
    for f, items in all_findings.items():
        print(f"\n{f}")
        for it in items:
            totals[it["cat"]] = totals.get(it["cat"], 0) + 1
            print(f"  L{it['line']:>4} [{it['cat']:<8}] {it['text'].strip()[:100]}")
    print("\n" + "=" * 50)
    if not all_findings:
        print("No suspicious comments.")
    else:
        print("Summary:", ", ".join(f"{k}={v}" for k, v in sorted(totals.items())))
        print("  divider/banner/empty  -> noise, removable with --fix")
        print("  code                  -> commented-out code, review and DELETE (dead code is not versioned)")
        print("  todo                  -> review: turn into an issue or remove")
        print("\nWHY vs WHAT: apply the skill's criterion to the remaining comments")
        print("(keep only those that explain the WHY; delete those that narrate the WHAT).")
        if args.fix:
            print(f"\n--fix: {fixed} noise lines removed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
