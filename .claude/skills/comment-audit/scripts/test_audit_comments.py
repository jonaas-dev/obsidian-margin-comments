#!/usr/bin/env python3
"""Cases for audit_comments.py. No dependencies: `python3 .claude/skills/comment-audit/scripts/test_audit_comments.py`."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("audit_comments.py")

SOURCE = """\
# ----------------------------------------
# keep: the API rate-limits at 5 rps, hence the sleep
# ========== SETUP ==========
#
# x = compute(1, 2)
# TODO: drop after the migration
value = 1
"""


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False)


def categories(path: Path) -> list[str]:
    out = run(str(path), "--json").stdout
    return [f["cat"] for f in json.loads(out).get(str(path), [])]


def main() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "sample.py"
        src.write_text(SOURCE)

        cats = categories(src)
        for expected in ("divider", "banner", "empty", "code", "todo"):
            if expected not in cats:
                failures.append(f"report: missing category {expected!r}, got {cats}")
        if "keep: the API" in "".join(cats):
            failures.append("report: a WHY comment must not be a finding")

        run(str(src), "--fix")
        after = src.read_text()
        for gone in ("-----", "SETUP"):
            if gone in after:
                failures.append(f"--fix: noise {gone!r} survived")
        for kept in ("keep: the API rate-limits", "x = compute", "TODO", "value = 1"):
            if kept not in after:
                failures.append(f"--fix: {kept!r} must survive (only divider/banner/empty go)")

        clean = Path(tmp) / "clean.py"
        clean.write_text("# why: vendor bug, see ticket 42\nvalue = 1\n")
        before = clean.read_text()
        run(str(clean), "--fix")
        if clean.read_text() != before:
            failures.append("--fix rewrote a file with no findings")

        # The check must fail when its own input is broken, not report green.
        if categories(Path(tmp) / "missing.py") != []:
            failures.append("a missing file must yield no findings, not crash into a fake result")

    for f in failures:
        print("FAIL:", f)
    print("OK" if not failures else f"{len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
