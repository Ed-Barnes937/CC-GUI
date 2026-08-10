# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Tauri 2 desktop app: the UI is a TypeScript/Vite web frontend rendered in a
native window. Per Impeccable, a native wrapper around web tech is `web`; the
design language is CSS/DOM, not native iOS/Android. -->

## Users

Primary users are the maintainers and a small circle of contributors — an
in-house tool, not a public product. All users are already fluent with the
terminal `claude-commander` TUI, tmux, and the `claude` CLI. They run **many
concurrent Claude coding sessions** across multiple projects and git worktrees
and want a native window to manage that fleet instead of the terminal TUI.

Because the audience is expert and internal, density, speed, and keyboard flow
outrank onboarding, discoverability, and hand-holding for unfamiliar users.

## Product Purpose

CC-GUI is a native desktop GUI for [`claude-commander`](https://github.com/sizeak/claude-commander).
It manages the lifecycle of tmux-backed Claude coding sessions — create, attach,
rename, restart, kill, delete, "restart fresh" — and layers on visual
capabilities the terminal can't offer: embedded PTY terminals, a code-review
diff view with inline comments, cascade (stacked-session) management, a file
explorer, a command palette, and split-pane layouts.

Success is a maintainer running a large parallel-agent workflow entirely from
one window: seeing at a glance which sessions need them, jumping between
sessions and terminals by keyboard, and reviewing/applying agent output without
leaving the app.

## Positioning

CC-GUI embeds `claude-commander` **as a library** (a pinned git dependency),
not as a separate subprocess, so it drives the exact same session model as the
CLI and stays in sync with whatever the CLI does. It is a real native desktop
app, not a web app in a frame.

The intended relationship to the TUI is **mirror-plus-native-extras**: stay in
sync with CC's core session model while freely adding GUI-only capabilities the
terminal can't do. Divergent product ideas are welcome when they're good, but
the default is to contribute shared improvements back upstream to CC — both CC
and CC-GUI are in-house tools maintained by the same person.

## Operating Context

- Developers running **multiple parallel agentic coding sessions** at once,
  grouped by project / section / section-stack, across repos and git worktrees.
- Every session runs in a **tmux** session; the GUI attaches via a real PTY
  (xterm.js).
- Heavy **keyboard-driven** use: command palette (`Cmd/Ctrl+K`), file explorer
  (`Cmd+E`), tab/session navigation, split panes.
- Cross-instance sync: config hot-reload picks up `claude-commander` config
  changes made elsewhere.
- Distribution: macOS (Apple Silicon) via Homebrew cask + `.dmg`, and Linux via
  `.AppImage` / `.deb`. The macOS build is unsigned.

## Capabilities and Constraints

Confirmed capabilities:

- **Session lifecycle** — create / attach / rename / restart / kill / delete /
  restart-fresh; liveness and unread indicators; grouping by project, section,
  or status.
- **Embedded terminals** — xterm.js over a real PTY; attaching recreates
  stopped sessions; up to 4 split panes.
- **Project shells** — plain shell terminal in a project or worktree directory.
- **Code review** — read-only diff view with inline comments; stage and
  **Apply** comments back to the agent.
- **Cascade** — merge / resume / abandon stacked sessions; push a stack.
- **File explorer** — keyboard-driven nnn-style browser; open a file to drop an
  `@path` reference into the terminal.
- **Command palette** — fuzzy jump to a session or run any command.
- **Theming** — 10 built-in themes plus user JSON themes with a live-preview
  picker. Theming is GUI-owned (independent of CC config; preferences in
  localStorage) and themes three surfaces: CSS chrome, the xterm terminal, and
  Shiki diff highlighting. *(Current capability, not a binding constraint.)*

Technical constraints:

- **Architecture**: the frontend talks to the Rust backend exclusively through
  Tauri commands (`invoke`) and events. All `claude-commander` logic lives in
  the backend; the frontend renders and dispatches. Command handlers stay thin;
  testable logic lives in library code.
- **Frontend is plain TypeScript modules** — no framework; follow existing
  DOM-building and event patterns.
- **macOS specifics**: packaging (`app:install`) and a login-shell `PATH` fix
  are macOS-only (a Finder-launched app gets a minimal `PATH`; the backend
  re-derives it so `tmux`, `node`, `git` resolve).
- `npm run typecheck` and `cargo fmt` / `cargo clippy` must pass before commits.

## Brand Commitments

- **Name**: CC-GUI, under the `Ed-Barnes937` personal account.
- **Binding constraints future design work must preserve** (user-confirmed):
  - **Native-desktop feel** — must read as a real native desktop app (window
    chrome, keyboard-first, dense), never a website in a frame.
  - **Full keyboard operability** — every action reachable by keyboard; the
    command palette and shortcuts are first-class, not optional.
  - **Telemetry transparency** — anonymous opt-out feature-usage telemetry must
    stay honest about what is and isn't sent; **no free-form text is ever
    transmitted** (no prompts, session content, comment bodies, names, or
    paths).

## Evidence on Hand

- Working shipping product (v0.11.0) with public distribution channels
  (Homebrew cask, GitHub Releases).
- Real docs: `README.md`, `CONTRIBUTING.md`, `docs/theming.md`,
  `docs/` plans (`PLAN.md`, `ui-overhaul/`, `ui-refactor/`, `ideas/`).
- Test suite: Vitest units + Playwright component ("iwft") tests.
- No customer testimonials, usage benchmarks, or third-party case studies exist;
  future work must not fabricate any.

## Product Principles

1. **Stay in sync with CC.** The GUI drives CC's real session model as a library;
   don't fork the core model — contribute shared improvements upstream.
2. **Expert density over onboarding.** The audience already knows the TUI, tmux,
   and the CLI; optimize for speed and information density, not first-run
   hand-holding.
3. **Keyboard-first, always.** Every capability must be operable without the
   mouse; the palette and shortcuts are the primary interface.
4. **Native, not web-in-a-frame.** Honor desktop conventions and window chrome;
   the app should never feel like an embedded website.
5. **Honest by construction.** Telemetry and any outbound data stay transparent
   and free of user content.

## Accessibility & Inclusion

Full keyboard operability is a confirmed, product-wide requirement (see Brand
Commitments). No additional product-specific accessibility standard has been
established.
