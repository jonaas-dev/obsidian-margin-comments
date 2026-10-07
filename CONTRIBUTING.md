# Contributing

## Requirements

- Node.js 22 or newer
- Obsidian (any recent desktop version)
- Python 3 (for the pre-commit checks)

## Setup

```sh
git clone https://github.com/jonaas-dev/obsidian-margin-comments.git
cd obsidian-margin-comments
npm install
sh ops/install-hooks.sh
```

`ops/install-hooks.sh` sets `core.hooksPath`. That setting is local to your clone and
does not travel with the repository, so a fresh clone has no pre-commit protection
until you run it. See the hooks section of [AGENTS.md](AGENTS.md) for what it blocks.

**Identity checks only apply to the maintainer.** Unless your clone sets
`hooks.maintainer` (which only `sh ops/install-hooks.sh --maintainer` does) or your
`user.name` is `jonaas-dev`, the hook does not enforce a particular email or name, and
CI does not check the identity on pull requests you open. The scanner still blocks
secrets and personal data (home paths, real email addresses in code, etc.) in the
staged diff.

## Development vault

**Never develop against a vault you care about.** This plugin writes to a
`.margin-comments/` folder at the vault root, and a bug during development can put
unexpected files there.

1. In Obsidian: **File → New vault**, name it something like `dev-margin-comments`.
2. Link this repository into that vault's plugin folder:

   ```sh
   # macOS / Linux, from the repository root
   ln -s "$(pwd)" <vault>/.obsidian/plugins/margin-comments
   ```

   ```powershell
   # Windows, from the repository root
   New-Item -ItemType Junction -Path <vault>\.obsidian\plugins\margin-comments -Target (Get-Location)
   ```

3. Enable **Margin Comments** in **Settings → Community plugins**. You will need
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
| `npm run format:check` | The same, reporting instead of writing — what CI runs |
| `npm test` | Vitest unit tests, single run |
| `npm run test:coverage` | Unit tests with coverage, failing below the thresholds CI enforces |
| `npm run test:e2e` | End-to-end tests driving a real Obsidian |
| `npm run test:watch` | Vitest in watch mode |
| `npm run sonar` | Unit coverage, then a SonarQube analysis (optional, see below) |

### Templates and conduct

Issues and pull requests open with a template. The bug one asks for the Obsidian
version, the platform, and **whether the note was changed outside Obsidian** — that
last question decides most reports about a comment that moved, because the plugin
anchors to the text and a change it never saw is the first thing to rule out.

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to everything here.

`.editorconfig` mirrors `.prettierrc` for editors that do not read it. It is a
convenience, not the rule: `npm run format:check` is what CI enforces.

### One-time setup

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

The repository had drifted from its own Prettier settings across 77 files, and
putting that right took one commit that touched almost everything. Without this
setting, `git blame` names that commit as the last author of every line it
reformatted. The file lists the commits worth skipping, and nothing goes in it
that is not provably formatting-only.

## Code quality (optional)

`npm run sonar` runs the unit suite with coverage and then analyses the repository on a
SonarQube server, with the scanner in Docker. CI does not run it: the server is local.

1. **A server.** Any SonarQube reachable from a container works. The default address is
   `http://host.docker.internal:9000`, because `localhost` inside the scanner container is the
   container itself. Set `SONAR_HOST_URL` to use another one. To try it out:

   ```sh
   docker run -d --name sonarqube -p 127.0.0.1:9000:9000 sonarqube:26.5.0.122743-community
   ```

2. **A project and a token.** Create a project with the key `obsidian-margin-comments`, then a
   *project analysis token* for it (**My Account → Security**).
3. **Run it** with the token in the environment, never in a file inside the repository:

   ```sh
   SONAR_TOKEN=<token> npm run sonar
   ```

The command stops with a named cause when the token is missing, coverage was not written, or no
server answers at the address. One cause it cannot check for the scanner is step 2: a token that
is valid but scoped to another project, or a project that was never created, ends the run with
`You're not authorized to analyze this project or the project doesn't exist on SonarQube`.

## End-to-end tests

`npm run test:e2e` launches a real Obsidian, loads the plugin into a throwaway vault
and drives it with Playwright. It needs Obsidian installed at
`/Applications/Obsidian.app` and currently runs on macOS only. On Linux or Windows,
or if your Obsidian binary lives elsewhere, set the `OBSIDIAN_APP` environment
variable to the full path of the executable.

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

- `npm run lint && npm run typecheck && npm run build && npm test && npm run test:coverage` all pass
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
| Every commit rejected on identity | `hooks.maintainer` set, or `user.name` is `jonaas-dev`, in a clone that is not the maintainer's |
| Handlers firing after disable | An event registered without `registerEvent()` |
