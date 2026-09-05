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

Saving a source file rebuilds `main.js` and Obsidian reloads the plugin. Changes to
`manifest.json` and `styles.css` are **not** picked up — restart Obsidian for those.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | esbuild in watch mode |
| `npm run build` | typecheck, then a production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src` and `tests` |
| `npm run format` | Prettier over `src` and `tests` |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |

## Before opening a pull request

- `npm run lint && npm run typecheck && npm test && npm run build` all pass
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
| Styles unchanged | `styles.css` needs a full Obsidian restart |
| Handlers firing after disable | An event registered without `registerEvent()` |
