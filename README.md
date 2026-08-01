# CC-GUI

A desktop GUI for [`claude-commander`](https://github.com/sizeak/claude-commander) — manage your Claude coding sessions from a native window instead of the terminal TUI. Built with [Tauri 2](https://tauri.app) (Rust backend) and a TypeScript/Vite frontend.

It embeds `claude-commander` directly (as a library) and drives the same tmux-backed sessions, so it stays in sync with whatever the CLI does.

## Features

- **Session management** — grouped by project / section / section-stack (cycle with `⇄`); liveness and unread indicators; rename, restart, kill, delete, and "restart fresh".
- **Embedded terminals** — attach to any session in a real PTY (xterm.js); attaching recreates stopped sessions. `Cmd+W` closes the active tab.
- **Project shells** — open a plain shell terminal in a project or worktree directory.
- **Code review** — read-only diff view with inline comments; stage comments and **Apply** them back to the agent.
- **Cascade** — merge, resume, and abandon stacked sessions; push a stack.
- **Theming** — 10 built-in themes plus your own custom themes, with a live-preview picker. See [`docs/theming.md`](docs/theming.md).
- **File explorer** (`Cmd+E`) — keyboard-driven, nnn-style browser of the active session's repo; open a file to drop an `@path` reference into the terminal.
- **Markdown viewer** (`Cmd+M`) — distraction-free reader for the active session's repo docs (plans, design docs, READMEs), with a fuzzy file picker (`/`) and in-repo link navigation.
- **Command palette** (`Cmd/Ctrl+K`) — fuzzy-jump to a session or run any command.
- **Config hot-reload** — picks up `claude-commander` config changes for multi-instance sync.

## Download

### Homebrew (macOS, Apple Silicon)

```sh
brew install --cask genio-learn/tap/cc-gui
```

The app is unsigned, so macOS quarantines it — but the cask clears the quarantine
flag automatically on install, so it opens straight away. (Homebrew removed the
old `--no-quarantine` flag in 5.x, with no replacement.) If macOS still reports
the app as *"damaged"*, clear the flag manually:
`xattr -dr com.apple.quarantine /Applications/CC-GUI.app`. Upgrade later with
`brew upgrade --cask cc-gui`.

### Manual download

Grab the latest build from [Releases](https://github.com/genio-learn/CC-GUI/releases):

- **macOS (Apple Silicon)** — `CC-GUI_<version>_aarch64.dmg` (`aarch64` = ARM64 = Apple Silicon)
- **Linux** — `CC-GUI_<version>_amd64.AppImage` (portable, runs on any distro) or `CC-GUI_<version>_amd64.deb`

The macOS app is **unsigned** (no Apple Developer certificate), so macOS quarantines it on download and reports it as *"damaged and can't be opened."* It isn't — that message just means "unsigned and quarantined." Drag `CC-GUI.app` into `/Applications`, then clear the quarantine flag:

```sh
xattr -cr /Applications/CC-GUI.app
```

Then open it normally. (If the `.dmg` won't even mount, clear it first: `xattr -c ~/Downloads/CC-GUI_*_aarch64.dmg`.)

To build from source instead, follow the rest of this guide.

## Prerequisites

| Requirement | Why | Install |
|-------------|-----|---------|
| **Rust toolchain** | Compiles the Tauri backend | [rustup.rs](https://rustup.rs) |
| **Node.js** | Builds the frontend | [nodejs.org](https://nodejs.org) (or nvm) |
| **tmux** | `claude-commander` runs every session in a tmux session | `brew install tmux` |
| **`claude` CLI** | The default program each session launches | [Claude Code](https://claude.com/claude-code) |

`claude-commander` itself is a pinned git dependency — Cargo fetches it automatically, so no separate checkout is required (unless you want to develop against a local copy; see [Setup](#setup)).

## Setup

```sh
git clone git@github.com:genio-learn/CC-GUI.git
cd CC-GUI
npm install
```

That's it. `claude-commander` is a pinned git dependency, so Cargo fetches it on the first build — no separate checkout needed.

> **Developing against a local `claude-commander`?** Copy `.cargo/config.toml.example` to `.cargo/config.toml` (gitignored) and place your checkout at `../claude-commander`. Cargo will then build against your local copy instead of the pinned release. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Running

**Development** (hot-reload frontend, runs in a dev window):

```sh
npm run tauri dev
```

**Packaged app** (build a real `.app` and install it to `/Applications`):

```sh
npm run app:install
```

Then launch **CC-GUI** from Finder / Spotlight / Launchpad like any other app. The first build compiles the Rust backend from scratch and takes a few minutes; later builds are incremental.

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run tauri dev` | Run the app in development with hot reload. |
| `npm run app:build` | Build the bundles (`.app` + `.dmg`) under `src-tauri/target/release/bundle/`. |
| `npm run app:install` | Build **and** (re)install into `/Applications`. Idempotent — use it for first install **and** every update. |
| `npm run typecheck` | Type-check the frontend (`tsc --noEmit`). |

## Updating

- **GUI changes** → `npm run app:install`, then relaunch the app.
- **Newer `claude-commander`** → bump the `tag` in `src-tauri/Cargo.toml` to the desired release, run `cargo update -p claude-commander` (from `src-tauri/`), then `npm run app:install`. Pinning to a tag means you adopt new CC releases deliberately.

After any reinstall, fully quit the running app (`Cmd+Q`) before relaunching so you pick up the new binary.

## Keyboard & mouse quick reference

Press `?` in the app (outside a text input) for the full, always-current list.

| Action | Binding |
|--------|---------|
| Command palette (jump to session / run command) | `Cmd/Ctrl+K` |
| Help overlay | `?` |
| Close active terminal tab | `Cmd+W` |
| Jump to terminal tab by number | `Cmd+1`–`Cmd+9` |
| Previous / next terminal tab | `Cmd+Opt+←` / `Cmd+Opt+→` |
| Previous / next session (attaches it) | `Cmd+Opt+↑` / `Cmd+Opt+↓` |
| Open/close file explorer (active session's repo) | `Cmd/Ctrl+E` |
| File explorer: move cursor | `↑`/`↓` or `j`/`k` |
| File explorer: open folder / reference file as `@path` | `Enter` / `→` / `l` |
| File explorer: up to parent / filter / toggle hidden | `Backspace` / `/` / `.` |
| Open/close markdown viewer (active session's repo) | `Cmd/Ctrl+M` |
| Markdown viewer: fuzzy file picker (`↑`/`↓` pick, `Enter` opens) | `/` or click the file name |
| Terminal: switch to this session's shell | `Ctrl+\` |
| Terminal: cursor to line start / end | `Cmd+←` / `Cmd+→` |
| Terminal: delete to line start | `Cmd+Backspace` |
| Terminal: newline without submitting | `Shift+Enter` |
| Terminal: copy selection (auto-clears highlight) | select text |
| Terminal: open a link | `Cmd+Click` |
| Reorder terminal tabs | drag a tab |
| Split the view into panes (up to 4) | drag a tab into a corner of the terminal area |
| Remove a pane from the split | pane header `✕` |
| Resize split panes | drag a pane border |
| Attach / recreate a session | click its row |
| Full session menu (shell, review, rename, editor, PR, lifecycle) | right-click row |
| New session in a project | `+` on the project |
| New session: pick the harness (Claude / Codex / OpenCode) | `↓` in the title field, or click the `command ▾` button |
| Add-project path: complete to common prefix | `Tab` |
| Add-project path: pick / drill into a directory | `↑` / `↓`, then `Enter` |
| Add-project path: native folder picker | `Browse…` |
| Project shell | `$` on the project |
| Switch sidebar grouping (Sections / Projects / Status) | `GROUP BY` control |
| Move a session to a section | drag its row onto a section header (drop on *In Progress* to unpin) |
| Review: select lines for a comment | click a line (shift-click extends), or click/drag the line numbers |
| Review: move the line cursor (comment without the mouse) | `j` / `k` |
| Review: comment the cursor line | `Enter` or `c` |
| Save a review comment | `Cmd/Ctrl+Enter` |
| Review: previous / next file | `↑` / `↓` or `Ctrl-P` / `Ctrl-N` |
| Review: toggle a file reviewed (bands the row) | click `○` / `✓` on the file row |
| Review: apply staged comments (press twice to confirm) | `Apply` button |
| Board: move focus between cards / columns | arrow keys |
| Board: attach the focused card | `Enter` / `Space` |

## Platform notes

The packaging scripts (`app:install`) and the login-shell PATH fix are macOS-specific. On a Finder-launched app, macOS provides a minimal `PATH`; the backend re-derives the full `PATH` from your login shell at startup so `tmux`, `node`, `git`, etc. resolve inside the app's terminals.

## Theming

CC-GUI owns its own theming (independent of `claude-commander` config). Ten themes ship built in, and you can drop your own JSON themes into the app's config folder without rebuilding. Full authoring guide: [`docs/theming.md`](docs/theming.md).

## Usage telemetry

CC-GUI embeds `claude-commander`, which reports anonymous **feature-usage** telemetry so the maintainers can see which features are used. It is **on by default** and **opt-out**, identifying itself as `cc-gui` so GUI usage is distinguishable from the terminal app.

**What is sent:** the name of each feature used (e.g. `review.open`), a coarse environment fingerprint (OS, architecture, shell name, terminal colour mode), a non-sensitive config snapshot (theme preset, view mode, which optional features are enabled), the app name + version, and a random, resettable install id.

**What is never sent:** typed text, prompts, Claude session content, comment bodies, branch/session names, repository paths, or command arguments. The event schema is a fixed set of typed fields with no path that forwards free-form text.

**To opt out**, either uncheck **telemetry (send anonymous usage)** in Settings (`Cmd/Ctrl+K` → "Settings"), set the config flag, or export the standard [`DO_NOT_TRACK`](https://consoledonottrack.com/) variable:

```toml
[telemetry]
enabled = false
```

See [`claude-commander`'s configuration docs](https://github.com/sizeak/claude-commander/blob/main/docs/configuration.md#usage-telemetry) for the full detail (and self-hosting the ingest endpoint).
