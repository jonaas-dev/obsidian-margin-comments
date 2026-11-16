#!/usr/bin/env python3
"""Cases for the graph guard. No dependencies: `python3 .claude/hooks/test_graph_hook.py`.

A fake `uvx` and a fake `code-review-graph` on PATH log every call to a file: that proves whether the
guard calls the binary, which one and with which `--repo`, without needing the real graph.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("graph_hook.py")

# `uvx code-review-graph <args>` logs only <args>; the stray binary adds a prefix to tell them apart.
FAKE_UVX = """#!/bin/sh
shift
echo "$@" >> "$CRG_CALLS"
[ "$1" = status ] && echo "Nodes: 42"
exit 0
"""
FAKE_BIN = """#!/bin/sh
echo "direct: $@" >> "$CRG_CALLS"
exit 0
"""


def make_env(tmp: Path, with_uvx: bool = True) -> dict[str, str]:
    bin_dir = tmp / ("bin" if with_uvx else "bin-direct")
    bin_dir.mkdir()
    fakes = {"code-review-graph": FAKE_BIN, **({"uvx": FAKE_UVX} if with_uvx else {})}
    for name, script in fakes.items():
        fake = bin_dir / name
        fake.write_text(script)
        fake.chmod(0o755)
    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["CRG_CALLS"] = str(tmp / "calls.log")
    return env


def git_repo(path: Path, with_graph: bool) -> Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    (path / "src").mkdir()
    (path / "src" / "a.py").write_text("x = 1\n")
    if with_graph:
        (path / ".code-review-graph").mkdir()
    return path.resolve()


def run(
    env: dict[str, str], args: list[str], stdin: str = "", cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HOOK), *args],
        check=False,
        input=stdin,
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
    )


def calls(env: dict[str, str]) -> list[str]:
    log = Path(env["CRG_CALLS"])
    return log.read_text().splitlines() if log.exists() else []


def main() -> int:
    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        if not cond:
            failures.append(f"{name}: {detail}")

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw).resolve()
        env = make_env(tmp)
        with_graph = git_repo(tmp / "with", with_graph=True)
        without_graph = git_repo(tmp / "without", with_graph=False)
        outside = tmp / "plain"
        outside.mkdir()

        # Claude PostToolUse: the edited file picks the repo, not the session cwd.
        payload = json.dumps(
            {
                "cwd": str(outside),
                "tool_input": {"file_path": str(with_graph / "src" / "a.py")},
            }
        )
        res = run(env, ["update"], stdin=payload)
        check(
            "update with graph",
            res.returncode == 0 and res.stdout == "",
            f"rc={res.returncode} out={res.stdout!r}",
        )
        check(
            "update with graph calls",
            calls(env) == [f"update --skip-flows --repo {with_graph}"],
            str(calls(env)),
        )

        Path(env["CRG_CALLS"]).unlink(missing_ok=True)
        payload = json.dumps(
            {
                "cwd": str(outside),
                "tool_input": {"file_path": str(without_graph / "src" / "a.py")},
            }
        )
        res = run(env, ["update"], stdin=payload)
        check(
            "update without graph",
            res.returncode == 0 and res.stdout == "",
            f"rc={res.returncode} out={res.stdout!r}",
        )
        check("update without graph does not call", calls(env) == [], str(calls(env)))

        res = run(env, ["update", "--path", str(outside)])
        check(
            "update outside git",
            res.returncode == 0 and res.stdout == "",
            f"rc={res.returncode} out={res.stdout!r}",
        )
        check("update outside git does not call", calls(env) == [], str(calls(env)))

        # A just-deleted file or a missing path: the first existing parent is used.
        res = run(env, ["update", "--path", str(with_graph / "src" / "gone" / "b.py")])
        check(
            "update missing path",
            calls(env) == [f"update --skip-flows --repo {with_graph}"],
            str(calls(env)),
        )

        # Claude SessionStart: only cwd in the payload; the output goes into context, hence the prefix.
        Path(env["CRG_CALLS"]).unlink(missing_ok=True)
        res = run(env, ["status"], stdin=json.dumps({"cwd": str(with_graph / "src")}))
        check(
            "status with graph",
            res.returncode == 0 and "Nodes: 42" in res.stdout,
            f"out={res.stdout!r}",
        )
        check(
            "status with graph calls",
            calls(env) == [f"status --repo {with_graph}"],
            str(calls(env)),
        )

        Path(env["CRG_CALLS"]).unlink(missing_ok=True)
        res = run(env, ["status"], stdin=json.dumps({"cwd": str(without_graph)}))
        check(
            "status without graph",
            res.returncode == 0 and res.stdout == "",
            f"out={res.stdout!r}",
        )
        res = run(env, ["status"], cwd=outside)
        check(
            "status outside git (no stdin)",
            res.returncode == 0 and res.stdout == "",
            f"out={res.stdout!r}",
        )
        check("status without graph does not call", calls(env) == [], str(calls(env)))

        # No binary on PATH (nor uvx): exits 0 silently even though the repo has a graph.
        bare = dict(env, PATH="/usr/bin:/bin")
        res = run(bare, ["update", "--path", str(with_graph)])
        check(
            "no binary",
            res.returncode == 0 and res.stdout == "" and res.stderr == "",
            f"{res!r}",
        )

        # Without uvx the stray binary is used; with uvx (every case above), never the stray one.
        (tmp / "d").mkdir()
        direct = dict(make_env(tmp / "d", with_uvx=False), PATH=f"{tmp / 'd' / 'bin-direct'}:/usr/bin:/bin")
        run(direct, ["update", "--path", str(with_graph)])
        check("without uvx uses the binary", calls(direct) == [f"direct: update --skip-flows --repo {with_graph}"], str(calls(direct)))

        # Inherited from a git hook (pre-push from a worktree): GIT_DIR must not divert the toplevel.
        Path(env["CRG_CALLS"]).unlink(missing_ok=True)
        elsewhere = git_repo(tmp / "elsewhere", with_graph=False)
        leaky = dict(
            env,
            GIT_DIR=str(elsewhere / ".git"),
            GIT_WORK_TREE=str(elsewhere),
            GIT_INDEX_FILE=str(elsewhere / ".git" / "index"),
        )
        res = run(leaky, ["status"], stdin=json.dumps({"cwd": str(with_graph / "src")}))
        check("status with inherited GIT_DIR", "Nodes: 42" in res.stdout, f"out={res.stdout!r}")
        check(
            "status with inherited GIT_DIR calls",
            calls(env) == [f"status --repo {with_graph}"],
            str(calls(env)),
        )

        res = run(env, ["update"], stdin="not json")
        check("invalid stdin", res.returncode == 0, f"rc={res.returncode}")

    for failure in failures:
        print(f"FAIL {failure}")
    print(f"{'OK' if not failures else 'KO'}: {len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
