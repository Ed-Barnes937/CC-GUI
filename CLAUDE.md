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

`main.ts` is boot only: it imports the view modules (each registers itself as
it loads) and starts the snapshot listener. The layers below it run
bottom-up — nothing in `app/` imports a view, and no view imports another.

- **`app/`** — the layer everything else sits on. `types.ts` (the shapes the
  backend pushes), `elements.ts` (the static chrome from `index.html`),
  `store.ts` (the current snapshot, the GUI-owned prefs, the optimistic
  delete/rename masks, and `applySnapshot`), `render.ts` (views register a
  renderer under a name; callers ask for a name via `requestRender`), and
  `actions.ts` (the invoke/catch/refresh wrappers).
- **`terminal/`** — `state.ts` (which terminals exist and where),
  `surface.ts` (the single/split/docked state machine), `attach.ts` (xterm +
  the PTY channel), `tabs.ts`, `restart.ts` (crash-loop guard).
- **`session/`** — what the sidebar and the board share: `row.ts` (row/card
  parts and the shared context menu), `selection.ts` (one keyboard cursor,
  drawn on both surfaces), `glyph.ts` (SessionRow → status vocabulary),
  `detail.ts`, `diffstat.ts`, `create.ts`.
- **`sidebar/`**, **`board/`** — the two session surfaces. Each has a
  `state.ts` its render modules share, so they don't import each other.
- **`chrome/`** — `titlebar.ts`, `attention.ts` (the queue behind both
  attention pills), `layout.ts` (the Console/Board swap), `commander.ts`,
  `onboarding.ts`.
- **`commands.ts`** — one `KEY_ACTIONS` table backing the palette, the
  configurable keybindings, and the accelerators that must beat xterm.
- **`palette.ts`** — `Cmd/Ctrl+K` fuzzy command/session palette.
- **`review/`** — the diff panel. `model.ts`/`pierre.ts` are the pure halves
  (unit-tested); `host.ts` owns the `@pierre/diffs` component and its caches,
  `state.ts` the open review plus a four-pane redraw registry, and `index.ts`
  the lifecycle and the diff pane. `files.ts`, `comments.ts`, `images.ts` and
  `apply.ts` render one region each and redraw through `state.ts`.
- **`theme/`** — GUI-owned theming: `types.ts` (the `Theme` shape),
  `palettes.ts` (the built-in literals), `validate.ts` (a user's theme file →
  a `Theme`), `index.ts` (the registry, the prefs, `applyTheme`/`onThemeChange`).
  Kept Tauri-free so it's also imported by the no-flash boot plugin in
  `vite.config.ts`. `modal.ts` is the live-preview picker and `custom.ts` loads
  user-authored themes from disk.
- **`settings/`** — the settings modal: `schema.ts` (every setting, declared),
  `controls.ts` (one field → one control), `sections.ts`, `panels.ts` (the
  GUI-only Features/Appearance tabs), `state.ts`, `shell.ts`, `index.ts`.
- **`menu.ts`, `keys.ts`, `help.ts`, `resize.ts`, `toast.ts`, `drag.ts`** — context menus, key handling, the `?` help overlay, panel resize, toasts, the shared pointer drag gesture.
- **`features.ts`, `featureList.ts`** — the optional-feature registry: features
  that not every user wants, contributing palette entries and keybindings and
  toggled in Settings → Features. See
  [ADR-0008](docs/adr/0008-optional-feature-registry.md); register a new one in
  `featureList.ts`, not in `commands.ts`.

Adding a view: register its renderer with `registerView`, read state from
`app/store.ts`, and ask for redraws with `requestRender` rather than calling
another view's render function.

## Theming

The GUI owns its theming independently of `claude-commander` config — it never
writes the commander config (`save_config`); preferences live in localStorage
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
