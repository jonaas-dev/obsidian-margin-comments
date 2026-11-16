#!/usr/bin/env python3
"""Knowledge graph hook, guarded per repository (`--path` sets the path by hand).

Usage: `graph_hook.py update|status [--path PATH]`. Without `--path`, the path comes from the Claude hook
JSON on stdin (`tool_input.file_path`, else `cwd`) and, as a last resort, from the process cwd.

It acts only when the git toplevel of that path has `.code-review-graph/`, and always with
`--repo <toplevel>`: an earlier global hook used `--repo $HOME` and kept an 11 GB graph of the whole home
directory. The edited file decides, not the cwd, because a session opened in one repository can edit
another.

Contract: always exits 0. Outside git, without a graph, without the binary or when the binary fails, it
prints nothing: a graph hook must never block or clutter an edit.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT = {"update": 25, "status": 8}
GIT_REPO_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX")
STATUS_HEADER = "[code-review-graph] This repo has a knowledge graph: use its MCP tools before Grep/Read."


def path_from_stdin() -> str | None:
    if sys.stdin is None or sys.stdin.isatty():
        return None
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict):
        return None
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict) and isinstance(tool_input.get("file_path"), str):
        return tool_input["file_path"]
    cwd = payload.get("cwd")
    return cwd if isinstance(cwd, str) else None


def existing_dir(raw: str) -> Path | None:
    # The file may not exist yet (a new Write) or may have been deleted: its first existing parent will do.
    path = Path(raw).expanduser()
    for candidate in (path, *path.parents):
        if candidate.is_dir():
            return candidate
    return None


def clean_git_env() -> dict[str, str]:
    # A git hook (pre-push, especially from a worktree) exports GIT_DIR, GIT_WORK_TREE and
    # GIT_INDEX_FILE: they override `-C`, and the toplevel would be the pushing repo, not the path's.
    return {k: v for k, v in os.environ.items() if k not in GIT_REPO_VARS}


def graph_root(raw: str) -> Path | None:
    start = existing_dir(raw)
    if start is None:
        return None
    try:
        res = subprocess.run(
            ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=clean_git_env(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if res.returncode != 0:
        return None
    root = Path(res.stdout.strip())
    return root if (root / ".code-review-graph").is_dir() else None


def graph_command() -> list[str] | None:
    # uvx first: it is what launches the MCP (`uvx code-review-graph serve`). A stray binary on PATH
    # may be an old version: 2.3.3 in ~/.local/bin missed edits to tracked files and the graph
    # silently went stale.
    if shutil.which("uvx"):
        return ["uvx", "code-review-graph"]
    if shutil.which("code-review-graph"):
        return ["code-review-graph"]
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=sorted(TIMEOUT))
    parser.add_argument("--path")
    args = parser.parse_args()

    root = graph_root(args.path or path_from_stdin() or str(Path.cwd()))
    command = graph_command()
    if root is None or command is None:
        return 0

    extra = ["--skip-flows"] if args.action == "update" else []
    try:
        res = subprocess.run(
            [*command, args.action, *extra, "--repo", str(root)],
            check=False,
            capture_output=True,
            text=True,
            timeout=TIMEOUT[args.action],
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if args.action == "status" and res.returncode == 0 and res.stdout.strip():
        print(f"{STATUS_HEADER}\n{res.stdout.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
