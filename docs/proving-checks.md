# Proving a check works

Detail behind the one-line rule in [AGENTS.md](../AGENTS.md): the cases that taught it.

## Proving a check works

**A check is not verified until you have watched it fail on bad input.** Confirming it
passes on good input proves nothing: a check that always passes also passes.

This is not a general principle someone wrote down here for tidiness. Three of the
checks in this repo's own verification setup shipped green and inert, and every one was
caught only by feeding it something that should have failed:

| What it looked like | What it did |
|---------------------|-------------|
| `except CalledProcessError: return 0` | Any git failure meant the leak scan reported success without scanning |
| `x=$(cmd \| filter \|\| true)` | Actions runs `bash -e` without `pipefail`, so a failing `cmd` was indistinguishable from a clean result |
| `git diff A..B` | Compares two tips, not the merge base: lines `main` deleted read as additions by the branch |
| Ignored CLI argument | `--range` was silently dropped and the scan fell back to an empty index, exiting 0 |

The shape they share: **the failure path produces the same output as success.** When
writing or reviewing a guard, ask what it does when its own machinery breaks — not when
the code it inspects is bad, but when git errors, an argument is wrong, or a pipe stage
dies. If that answer is "passes", it is decorative.

So, for every check added here:

1. Run it against input that must fail. Watch it fail.
2. Run it against input that must pass. Watch it pass.
3. Break the check's own dependency — bad range, missing file, wrong argument — and
   confirm it reports an error rather than success.

Record the negative case in the commit message or the test, so the next person does not
have to rediscover that it bites.

Two of this repo's own tests passed while proving nothing, and both were caught only
by breaking the code they covered:

| What it looked like | What it did |
|---------------------|-------------|
| "keeps the section open after resolving" | Asserted the section was still expanded, not that its cards were current. It passed against a build that never re-read the note. |
| "stores the scope in data.json" | Read the file after a filter had been clicked. Every setter saves the whole settings object, so the value was there whoever wrote it — the test passed against a plugin that never saved the scope. |
| "applies it to the open note without a reload" | Counted gutter markers after a settings toggle. Clicking in the tab stirs the workspace, `active-leaf-change` fires and the markers are redrawn by something other than the setting — so it passed against a tab whose commit never refreshed. |

Both share the shape above: **the failure path produces the same output as success.** For
persisted state, read the file before anything else can write it; for a redraw, assert on
data that only a fresh read could produce.

Both CI gates have been through this, in #42, each isolated:

| Input | Result |
|-------|--------|
| Fake home path + fake email in the diff | Scan failed with correct `file:line` over the three-dot range |
| Non-noreply author address, clean diff | Identity guard failed, naming the address |

Isolating them was not pedantry. The first run tripped the scan, and because job steps
stop at the first failure the identity guard was reported as `skipped` — a single
combined test would have looked like proof of both while proving one. Both commits used
`--no-verify`, which is the bypass these jobs exist to cover.
