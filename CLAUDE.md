# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and contributors working in this repo.

CC-GUI is a [Tauri 2](https://tauri.app) desktop app: a **Rust backend**
(`src-tauri/`) and a **TypeScript/Vite frontend** (`src/`). It embeds
[`claude-commander`](https://github.com/sizeak/claude-commander) as a library
and exposes its functionality through a native window. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and the dev loop.

## Commands

- `npm run tauri dev` — run the app with frontend hot reload
- `npm run typecheck` — `tsc --noEmit` (no-emit type check of the frontend)
- `npm run build` — type-check + Vite build of the frontend
- `npm run app:install` — build a release bundle and (re)install to `/Applications` (macOS)
- `cargo fmt --all` / `cargo clippy` — run from `src-tauri/`

## Architecture

The frontend talks to the Rust backend exclusively through Tauri **commands**
(`invoke`) and **events**. All `claude-commander` logic lives in the backend;
the frontend renders and dispatches.

### Backend (`src-tauri/src/`)

`main.rs` registers every Tauri command in one `invoke_handler` and, on macOS,
re-derives `PATH` from the login shell at startup (so child processes like
`tmux` resolve when launched from Finder). Command modules:

- **`sessions.rs`** — session lifecycle (create / kill / restart / delete / rename, detail, attach/shell prep).
- **`groups.rs`** — session grouping + view mode; drives the sidebar via a background loop.
- **`projects.rs`** — add/scan/remove projects, project shells, open-in-editor/external.
- **`review.rs`** — open a review diff, create/delete/apply comments.
- **`cascade.rs`** — merge / resume / abandon stacked sessions, push a stack.
- **`pty.rs`** — PTY attach/write/resize/detach backing the xterm terminals.
- **`commander.rs`** — the persistent commander session.
- **`settings.rs`** — read/save `claude-commander` config + keybindings.
- **`themes.rs`** — list/save custom themes, open the themes folder.
- **`service.rs` / `polling.rs`** — shared `claude-commander` service handle and background refresh loops.

### Frontend (`src/`)

- **`main.ts`** — boot + wiring: theme init, terminals, palette commands, session rendering, window events.
- **`palette.ts`** — `Cmd/Ctrl+K` fuzzy command/session palette.
- **`review.ts`** — diff rendering + inline review comments (via `@pierre/diffs`).
- **`theme.ts`** — GUI-owned theming: `Theme` type, built-in + custom registry, `applyTheme`/`onThemeChange`/`setMode`/`followSystem`. Kept Tauri-free so it's also imported by the no-flash boot plugin in `vite.config.ts`.
- **`themeModal.ts`** — the live-preview theme picker.
- **`menu.ts`, `keys.ts`, `help.ts`, `resize.ts`, `toast.ts`, `settings.ts`** — context menus, key handling, the `?` help overlay, panel resize, toasts, config UI.

## Theming

The GUI owns its theming independently of `claude-commander` config — it never
writes `settings.ts`/`save_config`; preferences live in localStorage
(`cc-theme-mode`, `cc-theme-light`, `cc-theme-dark`). Three surfaces are themed:
CSS chrome (semantic tokens in `style.css`), the xterm terminal (full `ITheme`),
and Shiki diff highlighting. Authoring guide: [`docs/theming.md`](docs/theming.md).

When adding or changing keyboard interactions, update the `HELP_SECTIONS` table
in `src/help.ts` (the `?` overlay) and the keyboard table in `README.md`.

## Conventions

- **Match the surrounding code.** Frontend is plain TypeScript modules (no
  framework); follow the existing DOM-building and event patterns. Backend
  follows `claude-commander`'s Rust style — `thiserror`, `tracing` over
  `println!`, thin command handlers that delegate to the embedded service.
- **Keep command handlers thin.** Logic worth testing belongs in library code
  (the `claude-commander` service or a dedicated helper), not inline in a Tauri
  command.
- `npm run typecheck` and `cargo fmt`/`cargo clippy` must pass before committing.

## Git conventions

- **Default to new commits, not rewritten history.** To change something you
  already pushed, add a commit — don't amend-and-force.
- **Force-pushing is a last resort, and always `--force-with-lease`** (never a
  bare `--force`, which discards whatever landed while you weren't looking).
  Never force-push `main` or any branch someone else is working on.
  - The one routine exception: maintaining a stack of PRs. `gh stack rebase`
    replays each branch onto its parent and `gh stack submit` force-pushes the
    result — that's how the tool works, and it doesn't need asking each time.
  - Anywhere else, **ask first.** An agent must get the user's say-so before
    force-pushing a branch that already has a PR on it.
- Branch names: lowercase with hyphens, no slashes (e.g. `fix-terminal-path`).
- Commit signing is on (SSH/1Password) — don't disable it.

## The claude-commander dependency

`src-tauri/Cargo.toml` pins `claude-commander` to a release **tag** via a git
dependency, so `Cargo.lock` records an exact commit (reproducible) and no
sibling checkout is needed. Upstream is a Cargo workspace (since v0.24.0); the
library CC-GUI consumes is the `claude-commander-core` crate. To build against
a local checkout for live CC development, copy `.cargo/config.toml.example` to
`.cargo/config.toml` (gitignored). To adopt a newer CC release, bump the `tag`
and run `cargo update -p claude-commander-core` — see
[CONTRIBUTING.md](CONTRIBUTING.md).
