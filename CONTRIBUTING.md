# Contributing

## Requirements

- Node.js 20 or newer
- Obsidian (any recent desktop version)
- Python 3 (for the pre-commit checks)

## Setup

```sh
git clone https://github.com/jonaas-dev/obsidian-inline-comments.git
cd obsidian-inline-comments
npm install
sh ops/install-hooks.sh
```

`ops/install-hooks.sh` sets `core.hooksPath`. That setting is local to your clone and
does not travel with the repository, so a fresh clone has no pre-commit protection
until you run it. See the hooks section of [AGENTS.md](AGENTS.md) for what it blocks.

**If you are not the maintainer**, tell the hook which address to expect before your
first commit, otherwise it rejects every one of them:

```sh
git config hooks.expectedEmail "$(git config user.email)"
```

The check exists so the published history never carries a personal inbox. Use your
own GitHub noreply address (`ID+username@users.noreply.github.com`, shown in GitHub
under Settings → Emails) rather than a real one.

## Development vault

**Never develop against a vault you care about.** This plugin writes to a
`.inline-comments/` folder at the vault root, and a bug during development can put
unexpected files there.

1. In Obsidian: **File → New vault**, name it something like `dev-inline-comments`.
2. Link this repository into that vault's plugin folder:

   ```sh
   # macOS / Linux, from the repository root
   ln -s "$(pwd)" <vault>/.obsidian/plugins/inline-comments
   ```

   ```powershell
   # Windows, from the repository root
   New-Item -ItemType Junction -Path <vault>\.obsidian\plugins\inline-comments -Target (Get-Location)
   ```

3. Enable **Inline Comments** in **Settings → Community plugins**. You will need
   community plugins turned on and restricted mode off.

## Hot reload

Install the [Hot-Reload](https://github.com/pjeby/hot-reload) plugin in the development
vault, then create the marker file this repository is watched by:

```sh
touch .hotreload
```

Run the watcher:

```sh
npm run dev
```

Saving a source file rebuilds `main.js` and Obsidian reloads the plugin. Hot-Reload
watches `styles.css` too, so stylesheet edits land the same way. Only `manifest.json`
needs a full Obsidian restart.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | esbuild in watch mode |
| `npm run build` | typecheck, then a production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src` and `tests` |
| `npm run format` | Prettier over `src` and `tests` |
| `npm test` | Vitest unit tests, single run |
| `npm run test:e2e` | End-to-end tests driving a real Obsidian |
| `npm run test:watch` | Vitest in watch mode |

## End-to-end tests

`npm run test:e2e` launches a real Obsidian, loads the plugin into a throwaway vault
and drives it with Playwright. It needs Obsidian installed at
`/Applications/Obsidian.app` and currently runs on macOS only.

**Run `npm run build` first, every time.** The suite loads `main.js`, not the
TypeScript, so without a build you are testing the previous version — and the symptom
is not an error but a pass or a failure that describes code you no longer have. This
has cost more time in this repository than any other single mistake.

Two details are load-bearing, both discovered the hard way:

- **Playwright's Electron support does not work here.** It needs the `--inspect`
  fuse, which this production build disables, so the harness attaches to the
  renderer over `--remote-debugging-port` instead.
- **A private `--user-data-dir` is required.** Without it the launch silently hands
  off to whatever Obsidian you already have open and exits, and the test hangs
  waiting for a window that belongs to another process.

A fresh profile always starts in Restricted Mode, so the harness enables the plugin
explicitly and dismisses the resulting dialog — its backdrop swallows synthetic
pointer events, which makes hover behaviour look broken when it is merely covered.

**Focus behaves differently under CDP.** Focus set programmatically is dropped
shortly afterwards, with `relatedTarget` null, while `document.hasFocus()` still
reports true — and Playwright's `fill()` leaves `activeElement` on BODY. None of
that happens to a real user. Click the element before typing in a test, and
verify anything focus-dependent by hand.

### Why these tests are local-only

**Decision: the end-to-end suite runs on a contributor's machine, not in CI.**

Not because it could not be done — a macOS runner can install Obsidian from a Homebrew
cask — but because of what that would buy and cost:

- The suite needs a real GUI session and a real application download on every run. That
  is minutes of setup per job for a plugin whose logic is already covered by the unit
  suite, which CI does run.
- Every assertion in it is really a race: a selector that has 30 seconds to appear, a
  wait for the plugin to write a sidecar. On a loaded shared runner those become
  flakiness rather than failures. This repository already has evidence that timing bites
  there — a performance budget in the *unit* suite failed once in CI at 112 ms against
  100 ms, and the fix was to make the case bigger rather than to raise the number. A
  suite people learn to re-run is worse than no suite.
- It drives a proprietary application that this project does not ship or control.
  A CI job that downloads it on every pull request makes the build depend on a vendor's
  download endpoint staying up and on their terms permitting it.

**What covers the suite instead.** CI type-checks and lints `tests/e2e/` along with
everything else — `tsconfig.json` includes `tests/**/*.ts` and `npm run lint` covers
`tests` — so the harness cannot silently rot into code that no longer compiles. What CI
cannot tell you is whether the tests still *pass*, which is why running them is part of
the pull request checklist below.

**To reverse this**, add a `macos-latest` job that installs Obsidian, runs
`npm run build` and then `npm run test:e2e`. Expect to widen the harness timeouts
before that job is worth believing.

The full list of what this harness will and will not do — the controls Obsidian never
attaches, the focus it cannot hold, the dropdowns it builds twice — is in the
"The E2E harness" section of [AGENTS.md](AGENTS.md). Read it before writing a test
that fails for no visible reason.

## Before opening a pull request

- `npm run lint && npm run typecheck && npm test && npm run build` all pass
- `npm run build && npm run test:e2e` passes, if you touched the UI, the editor
  extensions or anything that reads or writes the vault. CI cannot run this suite
  (see above), so a pull request is the last place it gets checked
- The work is on a branch, never committed straight to `main`
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- No personal data in the diff — the pre-commit hook checks, and CI enforces it

## Debugging

Open DevTools with `Cmd/Ctrl + Shift + I`. The Console tab shows errors; the Sources
tab lets you set breakpoints in the bundled `main.js` (inline source maps are enabled
in development builds).

Common problems:

| Symptom | Cause |
|---------|-------|
| Changes not appearing | Stale build — check `npm run dev` is still running |
| Plugin missing after a manifest edit | `manifest.json` needs a full Obsidian restart |
| Every commit rejected on identity | `hooks.expectedEmail` not set for your address |
| Handlers firing after disable | An event registered without `registerEvent()` |
