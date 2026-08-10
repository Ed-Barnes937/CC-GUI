# Contributing

Thanks for helping improve CC-GUI. This covers local setup, the dev loop, and
what's expected on a pull request. Architecture and coding conventions live in
[CLAUDE.md](CLAUDE.md).

## Setup

CC-GUI is a [Tauri 2](https://tauri.app) app (Rust backend + TypeScript/Vite
frontend) that depends on [`claude-commander`](https://github.com/sizeak/claude-commander)
as a **pinned git dependency** — Cargo fetches it on the first build, so no
separate checkout is required.

```sh
git clone git@github.com:Ed-Barnes937/CC-GUI.git
cd CC-GUI
npm install
```

You'll also need: the **Rust toolchain** ([rustup](https://rustup.rs)),
**Node.js**, **tmux** (`brew install tmux`), and the **`claude` CLI**. See the
[README](README.md#prerequisites) for the full prerequisite table.

### Developing against a local claude-commander

If you're changing `claude-commander` alongside CC-GUI and want those edits to
build here immediately, copy the example override and place your checkout at
`../claude-commander`:

```sh
cp .cargo/config.toml.example .cargo/config.toml   # gitignored
git clone git@github.com:sizeak/claude-commander.git ../claude-commander
```

Cargo then substitutes your local crate for the pinned git dependency, with no
`Cargo.toml` change. Your checkout's version must match the pinned tag's version
or Cargo ignores the override.

## Dev loop

```sh
npm run tauri dev      # run the app with frontend hot reload
npm run typecheck      # tsc --noEmit
npm run app:install    # build a release bundle and install to /Applications (macOS)
```

Rust checks run from `src-tauri/`:

```sh
cd src-tauri
cargo fmt --all
cargo clippy --all-targets -- -D warnings
```

A Husky **pre-commit hook** (installed automatically by `npm install` via the
`prepare` script) runs the fast checks on staged files: `cargo fmt --check`
when `.rs` files change and `npm run typecheck` when `.ts` files change. Clippy
stays in CI. Bypass with `git commit --no-verify` when needed.

## Pull requests

Before opening a PR, make sure:

- `npm run typecheck` passes.
- `cargo fmt --all -- --check` passes (run `cargo fmt --all` to fix).
- `cargo clippy` is clean.
- Any change to keyboard interactions updates **both** `src/help.ts`
  (the `?` overlay) and the keyboard table in `README.md`.
- Changes to theming stay consistent with [`docs/theming.md`](docs/theming.md).

CI runs the frontend type-check + build, a Rust format check, and clippy
(`-D warnings`) on every PR.

### Conventions

- Branch names: lowercase with hyphens, no slashes (e.g. `fix-terminal-path`).
- **Never force push** — create new commits instead.
- Match the style of the surrounding code; keep Tauri command handlers thin and
  push testable logic into library code (see [CLAUDE.md](CLAUDE.md)).

## Updating the claude-commander dependency

CC-GUI pins `claude-commander` to a release tag in `src-tauri/Cargo.toml`. To
adopt a newer release, bump the `tag`, then refresh the lockfile:

```sh
cd src-tauri
cargo update -p claude-commander-core
```

(`claude-commander-core` is the library crate inside the upstream workspace —
since v0.24.0 the repo is a workspace and the TUI binary owns the
`claude-commander` name.)

Commit the `Cargo.toml` + `Cargo.lock` change together so the pinned commit is
recorded.
