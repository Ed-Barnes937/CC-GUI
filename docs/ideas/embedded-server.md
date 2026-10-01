# Idea: run CC's HTTP server inside the GUI (remote and web access)

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library surface available since
> claude-commander **v0.37.0** (upstream #314; web UI served by the server
> since **v0.38.0**, #322).

## What this is

Since v0.37.0 the TUI runs CC's HTTP API inside its own process, sharing its
`CommanderService` - one set of background loops, one `state.json` writer -
instead of a separate `claude-commander-server` process. Remote clients (the
Flutter app, the browser web UI the server now serves) then see exactly the
sessions the TUI sees. CC-GUI could do the same, so a phone or another machine
can reach the GUI's sessions.

## The library surface

`claude-commander-server` (a new dependency for CC-GUI - it pulls in axum,
tower-http and rust-embed; core itself does not):

- `embed::start(service, &ServerConfig, AuthConfig) -> Result<EmbeddedServer, StartError>`
  - binds and serves on a background task. It deliberately does **not** start
  background or hibernation loops, which suits the GUI: it already runs them
  (`src-tauri/src/polling.rs`).
- `EmbeddedServer::{addr, url, join}`; `StartError` includes the bind failure
  (port taken - often a standalone server or a TUI already serving).
- `embed::token_decision(&ServerConfig) -> TokenDecision` - `Existing(token)`
  or `Generated(token)`. A generated token should be persisted so paired
  clients survive restarts: `claude_commander_core::config::persist_token`
  (atomic, `0o600`).
- `check_no_auth_bind` refuses an unauthenticated non-loopback bind.

Config - `claude_commander_core::config::ServerConfig` (the `[server]` table):
`auto_start` (default off), `bind` (default loopback), `port` (default 7878),
`token`, `tls_cert_path` / `tls_key_path`, `cors_allowed_origins`.

## GUI integration

- Backend: a small `src-tauri/src/server.rs` that, when `server.auto_start`
  is set (or the user turns it on), calls `embed::start` with the shared
  service from `service.rs`, persists a generated token, and exposes a thin
  `server_status` command (`Listening { url, token }` / `Failed { reason }`,
  mirroring the TUI's `EmbeddedServerStatus`).
- Settings: the `[server]` fields belong in `src/settings/schema.ts`; show the
  URL and a copy-token button (CC's `CopyServerToken` action is the TUI
  equivalent) in Settings and the palette.
- Port clash: the TUI and the GUI can't both serve 7878. Surface `Failed`
  plainly rather than retrying on another port - the likely cause is another
  frontend already serving the same state.

## Open questions

- Is the GUI the right host? A user running the GUI and TUI together should
  have exactly one of them serving; `auto_start` in shared config would make
  whichever starts first win.
- Whether to gate it behind the optional-feature registry (ADR-0008) since
  most users won't want a listening port.

## Verification (when implemented)

- Integration: start against a temp config, hit `GET /workspace` (the snapshot) with and without
  the bearer token, assert 200 / 401.
- iwft: Settings shows the listening URL, and the bind-failure message when
  the simulator reports the port taken.
