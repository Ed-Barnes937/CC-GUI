# Idea: dictate into the attached session

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library surface available since
> claude-commander **v0.37.0** (upstream #318), refined in **v0.38.0**
> (#323, #324).

## What this is

The TUI's Alt-t records the microphone, transcribes it with an
OpenAI-compatible speech-to-text server, and types the text into the attached
pane - optionally pressing Enter afterwards. CC-GUI could offer the same into
its xterm terminals.

## The library surface

CC-GUI builds core with `default-features = false`, which drops the `audio`
feature - so CC's microphone `Recorder` (cpal) is unavailable. Everything
after capture is not audio-gated:

- `claude_commander_core::conversation::SttClient::new(&SttConfig)` and
  `transcribe(wav: Vec<u8>) -> Result<String, _>` - posts to
  `{base_url}/audio/transcriptions`.
- `plan_dictation(raw, DictationSubmit, PaneInfo) -> Option<DictationPlan>` -
  normalises the transcript (`normalise_dictation`) and decides the text to
  type and whether an Enter follows, with the per-harness submit delay
  (`AgentKind::submit_key_delay`, 250ms for Claude and Codex since v0.38.0).
  An empty transcript is `None`, so silence never sends a bare Enter.
- Config: `[stt]` (`enabled`, `base_url`, `model`, `language`, `prompt`,
  `api_key`) and `dictation_submit` (`never` / `agent` / `always`).

## GUI integration

- Capture in the webview (`getUserMedia` + encode WAV), not in Rust - this
  keeps the `audio` feature (and its PipeWire link on Linux) off.
- A thin `dictate(tmux_session, wav)` command: `transcribe`, then
  `plan_dictation` with a `PaneInfo` for the attached pane, then write the
  text (and the delayed Enter, if planned) through the existing PTY writer
  in `src-tauri/src/pty.rs`.
- A push-to-talk accelerator in `src/commands.ts` (it must beat xterm), a
  recording indicator on the terminal, and `[stt]` / `dictation_submit` in
  `src/settings/schema.ts`. Update `src/help.ts` and the README keyboard
  table.
- macOS needs `NSMicrophoneUsageDescription` in the bundle's Info.plist.

## Open questions

- Value depends on the user running a local or LAN speech-to-text server;
  without `[stt]` configured the feature should stay hidden. A good fit for
  the optional-feature registry (ADR-0008).

## Verification (when implemented)

- Unit: the WAV encoder.
- iwft: with the simulator returning a canned transcript, assert the PTY
  received the text, and the Enter only under the `agent` / `always` policies.
