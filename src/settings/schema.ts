// What the settings pane offers: the control vocabulary, and the categories
// built out of it.
//
// Config categories are schema-driven -- each field declares a control (toggle,
// number, select, string-list, ...) and a dot-path into the claude-commander
// config -- so adding a setting is a line here, not a line of DOM. The two
// GUI-only categories (Appearance, Features) declare a `custom` renderer
// instead, because they edit localStorage rather than a config path.

export type Config = Record<string, unknown>;

export type SelectOption = { value: string; label: string };

export type Control =
  | { kind: "toggle" }
  | { kind: "number"; min?: number; max?: number; step?: number; unit?: string }
  | { kind: "number-nullable"; min?: number; max?: number; unit?: string }
  | { kind: "text"; placeholder?: string }
  | { kind: "path"; placeholder?: string }
  | { kind: "nullable"; placeholder?: string }
  | { kind: "select"; options: SelectOption[] }
  | { kind: "tristate-null"; auto: string; on: string; off: string }
  | { kind: "string-list"; placeholder?: string };

export type Field = {
  path: string;
  label: string;
  desc?: string;
  control: Control;
  /** Only editable when this boolean path is `true` (master-toggle gating). */
  enabledBy?: string;
};

export type Category =
  | { id: string; label: string; fields: Field[]; note?: string }
  | { id: string; label: string; custom: "sections"; note?: string }
  | { id: string; label: string; custom: "theme"; note?: string }
  | { id: string; label: string; custom: "features"; note?: string };

export const COMMANDER_CATEGORIES: Category[] = [
  {
    id: "general",
    label: "General",
    fields: [
      { path: "default_program", label: "Default program", desc: "Legacy fallback program for new sessions; the Programs list (first entry) takes priority when set.", control: { kind: "nullable", placeholder: "claude" } },
      { path: "branch_prefix", label: "Branch prefix", desc: "Prefix for new session branch names (blank = none).", control: { kind: "text", placeholder: "(none)" } },
      { path: "shell_program", label: "Shell program", desc: "Shell used for shell sessions.", control: { kind: "text" } },
      { path: "editor", label: "Editor command", desc: "Editor/IDE for opening sessions (e.g. code, zed, nvim). Blank falls back to $VISUAL / $EDITOR.", control: { kind: "nullable", placeholder: "$VISUAL / $EDITOR" } },
      { path: "editor_gui", label: "Editor type", desc: "Whether the editor is a GUI app. Auto-detects from a known list when unset.", control: { kind: "tristate-null", auto: "Auto-detect", on: "GUI", off: "Terminal" } },
      { path: "leader_key", label: "Leader key", desc: 'Quick-switch leader key (e.g. " ", ctrl+k, f1).', control: { kind: "text" } },
    ],
  },
  {
    id: "sessions",
    label: "Sessions & Worktrees",
    fields: [
      { path: "worktrees_dir", label: "Worktrees directory", desc: "Where session worktrees are created. Blank uses the default data dir.", control: { kind: "path", placeholder: "(default)" } },
      { path: "per_repo_worktree_dirs", label: "Per-repo worktree dirs", desc: "Organize worktrees into per-repository subdirectories.", control: { kind: "toggle" } },
      { path: "fetch_before_create", label: "Fetch before create", desc: "Fetch latest from origin before creating a new session.", control: { kind: "toggle" } },
      { path: "resume_session", label: "Resume sessions", desc: "Pass --resume when restarting/recreating a session so the agent picks up where it left off.", control: { kind: "toggle" } },
      { path: "nix_develop", label: "Use nix develop", desc: "Launch sessions inside `nix develop` when the project has a flake.nix and nix is on PATH.", control: { kind: "toggle" } },
      { path: "in_progress_limit", label: "In-progress WIP limit", desc: "Advisory limit for the catch-all section. Blank = no limit.", control: { kind: "number-nullable", min: 1 } },
    ],
  },
  {
    id: "hibernation",
    label: "Hibernation",
    note: "Automatically stop idle sessions to free memory (~400MB per idle agent), keeping the worktree and metadata. A hibernated session resumes its agent on wake. Enabling hibernation and changing the check interval take effect after restarting the app.",
    fields: [
      { path: "hibernate_enabled", label: "Enable hibernation", desc: "Run the background loop that hibernates idle sessions.", control: { kind: "toggle" } },
      { path: "hibernate_idle_timeout_secs", label: "Idle timeout", desc: "Seconds a session must be idle (agent Idle, nothing attached) before it hibernates. 0 = never hibernate.", control: { kind: "number", min: 0, unit: "s" }, enabledBy: "hibernate_enabled" },
      { path: "hibernate_check_interval_secs", label: "Check interval", desc: "Seconds between hibernation policy checks (effective minimum 30). 0 disables the loop.", control: { kind: "number", min: 0, unit: "s" }, enabledBy: "hibernate_enabled" },
    ],
  },
  {
    id: "git",
    label: "Git & PRs",
    fields: [
      { path: "pr_check_interval_secs", label: "PR check interval", desc: "Seconds between GitHub PR checks (0 = disabled).", control: { kind: "number", min: 0, unit: "s" } },
      { path: "project_pull_enabled", label: "Project pull", desc: "Periodically fast-forward each project's main branch from origin.", control: { kind: "toggle" } },
      { path: "project_pull_interval_secs", label: "Project pull interval", desc: "Seconds between project-branch pulls (minimum 60).", control: { kind: "number", min: 60, unit: "s" }, enabledBy: "project_pull_enabled" },
      { path: "pr_review_labels", label: "Review-needed labels", desc: "PR labels (one per line) that colour a PR badge as awaiting reviewer action.", control: { kind: "string-list", placeholder: "ready-for-test" } },
    ],
  },
  {
    id: "ai",
    label: "AI summaries",
    fields: [
      { path: "ai_summary_enabled", label: "AI branch summaries", desc: "Generate AI summaries of branch changes in the Info pane.", control: { kind: "toggle" } },
      { path: "ai_summary_model", label: "Summary model", desc: "Claude model for AI summaries (Haiku recommended for cost).", control: { kind: "text" }, enabledBy: "ai_summary_enabled" },
    ],
  },
  {
    id: "commander",
    label: "Commander",
    note: "The persistent top-level Claude session that coordinates other sessions.",
    fields: [
      { path: "commander_enabled", label: "Enable commander", desc: "Run the persistent commander session.", control: { kind: "toggle" } },
      { path: "commander_program", label: "Commander program", desc: "Program (with flags) for the commander session. Blank uses the default program.", control: { kind: "nullable", placeholder: "(default program)" }, enabledBy: "commander_enabled" },
      { path: "commander_dir", label: "Commander directory", desc: "Working directory for the commander session. Blank uses <data dir>/commander.", control: { kind: "path", placeholder: "(default)" }, enabledBy: "commander_enabled" },
    ],
  },
  {
    id: "conversation",
    label: "Conversation (TTS)",
    note: "Speak the commander's replies aloud via an OpenAI-compatible TTS engine.",
    fields: [
      { path: "conversation.enabled", label: "Enable conversation mode", desc: "Master switch for the Alt-c overlay and spoken replies.", control: { kind: "toggle" } },
      { path: "conversation.name", label: "Assistant name", desc: "Display name / nickname for the assistant.", control: { kind: "text" }, enabledBy: "conversation.enabled" },
      { path: "conversation.command", label: "Command", desc: "Binary to run for the headless conversation session.", control: { kind: "text" }, enabledBy: "conversation.enabled" },
      { path: "conversation.permission_mode", label: "Permission mode", desc: "--permission-mode for the conversation agent.", control: { kind: "text" }, enabledBy: "conversation.enabled" },
      { path: "conversation.base_url", label: "TTS base URL", desc: "OpenAI-compatible TTS API base URL (include /v1).", control: { kind: "text" }, enabledBy: "conversation.enabled" },
      { path: "conversation.model", label: "Model", desc: "Model name sent with each request.", control: { kind: "text" }, enabledBy: "conversation.enabled" },
      { path: "conversation.voice", label: "Voice", desc: "Voice name. Blank uses the server default.", control: { kind: "nullable", placeholder: "(server default)" }, enabledBy: "conversation.enabled" },
      { path: "conversation.response_format", label: "Response format", desc: "Audio container requested per chunk.", control: { kind: "select", options: [{ value: "wav", label: "wav" }, { value: "mp3", label: "mp3" }] }, enabledBy: "conversation.enabled" },
      { path: "conversation.speed", label: "Speed", desc: "Playback speed (0.25–4.0).", control: { kind: "number", min: 0.25, max: 4, step: 0.05 }, enabledBy: "conversation.enabled" },
      { path: "conversation.speak_scope", label: "Speak scope", desc: "How much of each reply to speak.", control: { kind: "select", options: [{ value: "prose_only", label: "Prose only" }, { value: "final_summary", label: "Final summary" }, { value: "verbatim", label: "Verbatim" }] }, enabledBy: "conversation.enabled" },
      { path: "conversation.volume", label: "Volume", desc: "Playback volume (0.0–2.0; 1.0 = unchanged).", control: { kind: "number", min: 0, max: 2, step: 0.05 }, enabledBy: "conversation.enabled" },
    ],
  },
  {
    id: "stt",
    label: "Voice input (STT)",
    note: "Transcribe the microphone via an OpenAI-compatible engine (Alt-V). Useful with conversation mode running.",
    fields: [
      { path: "stt.enabled", label: "Enable voice input", desc: "Master switch for voice input.", control: { kind: "toggle" } },
      { path: "stt.base_url", label: "STT base URL", desc: "OpenAI-compatible transcription API base URL (include /v1).", control: { kind: "text" }, enabledBy: "stt.enabled" },
      { path: "stt.model", label: "Model", desc: "Model name sent with each request.", control: { kind: "text" }, enabledBy: "stt.enabled" },
      { path: "stt.language", label: "Language", desc: "ISO-639-1 language hint. Blank auto-detects.", control: { kind: "nullable", placeholder: "(auto)" }, enabledBy: "stt.enabled" },
      { path: "stt.prompt", label: "Decoding prompt", desc: "Optional domain vocabulary / spelling hints.", control: { kind: "nullable", placeholder: "(none)" }, enabledBy: "stt.enabled" },
      { path: "stt.api_key", label: "API key", desc: "Bearer token, sent when set. Blank for local servers.", control: { kind: "nullable", placeholder: "(none)" }, enabledBy: "stt.enabled" },
      { path: "stt.pause_media", label: "Pause media while recording", desc: "Pause other players while recording, resuming when the reply finishes.", control: { kind: "toggle" }, enabledBy: "stt.enabled" },
    ],
  },
  {
    id: "telemetry",
    label: "Telemetry",
    note: "Anonymous feature-usage only — never typed text, prompts, session content, or paths.",
    fields: [
      { path: "telemetry.enabled", label: "Send anonymous usage", desc: "On by default; opt out here or set DO_NOT_TRACK.", control: { kind: "toggle" } },
      { path: "telemetry.endpoint", label: "Ingest endpoint", desc: "Override endpoint (self-hosters). Blank uses the built-in.", control: { kind: "nullable", placeholder: "(built-in)" } },
      { path: "telemetry.token", label: "Ingest token", desc: "Override credential (base64 email:token). Blank uses the built-in.", control: { kind: "nullable", placeholder: "(built-in)" } },
    ],
  },
  { id: "sections", label: "Sections", custom: "sections", note: "Group sessions in the list. Rules are evaluated top-to-bottom; the first match wins. Unmatched sessions fall into the built-in catch-all. Renaming or removing a section moves any manually-pinned sessions back to In Progress." },
  {
    id: "tui",
    label: "Terminal UI",
    note: "These affect the claude-commander terminal UI, not this GUI.",
    fields: [
      { path: "invert_pr_label_color", label: "Plain PR labels", desc: "Render PR labels as coloured text instead of pills.", control: { kind: "toggle" } },
      { path: "show_session_program", label: "Show session program", desc: "Show each session's program as a (program) suffix.", control: { kind: "toggle" } },
      { path: "dim_unfocused_preview", label: "Dim unfocused preview", desc: "Dim the right pane when the session list is focused.", control: { kind: "toggle" } },
      { path: "dim_unfocused_opacity", label: "Dim opacity", desc: "0.0 = fully dimmed, 1.0 = no dimming.", control: { kind: "number", min: 0, max: 1, step: 0.05 }, enabledBy: "dim_unfocused_preview" },
      { path: "rounded_borders", label: "Rounded borders", desc: "Use rounded border corners.", control: { kind: "toggle" } },
      { path: "ui_refresh_fps", label: "UI refresh rate", desc: "TUI refresh rate.", control: { kind: "number", min: 1, unit: "fps" } },
      { path: "precompute_review_caches", label: "Precompute review caches", desc: "Build every file's diff/highlight cache up front when opening review.", control: { kind: "toggle" } },
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    fields: [
      { path: "max_concurrent_tmux", label: "Max concurrent tmux", desc: "Maximum concurrent tmux commands.", control: { kind: "number", min: 1 } },
      { path: "capture_cache_ttl_ms", label: "Capture cache TTL", desc: "Content capture cache TTL.", control: { kind: "number", min: 0, unit: "ms" } },
      { path: "diff_cache_ttl_ms", label: "Diff cache TTL", desc: "Diff cache TTL.", control: { kind: "number", min: 0, unit: "ms" } },
      { path: "state_sync_interval_ms", label: "State sync interval", desc: "Polling interval for state changes from other instances (0 = disabled).", control: { kind: "number", min: 0, unit: "ms" } },
      { path: "agent_state_poll_interval_ms", label: "Agent state poll interval", desc: "Polling interval for agent Working/Idle/Waiting state (0 = disabled).", control: { kind: "number", min: 0, unit: "ms" } },
      { path: "session_number_debounce_ms", label: "Session-number debounce", desc: "Debounce when typing multi-digit session numbers.", control: { kind: "number", min: 0, unit: "ms" } },
      { path: "debug", label: "Debug logging", desc: "Enable debug logging.", control: { kind: "toggle" } },
      { path: "log_file", label: "Log file", desc: "Log to this file instead of stderr. Blank logs to stderr.", control: { kind: "path", placeholder: "(stderr)" } },
    ],
  },
];

export const THEME_CATEGORY: Category = {
  id: "theme",
  label: "Appearance",
  custom: "theme",
  note: "Theme preferences are stored locally for this GUI and don't affect the claude-commander config.",
};

export const FEATURES_CATEGORY: Category = {
  id: "features",
  label: "Features",
  custom: "features",
  note: "Optional parts of this GUI you can switch off. Like theme preferences, these are stored locally and don't affect the claude-commander config. Changes apply immediately.",
};

// One nav for everything: Appearance sits with the config categories, right
// after General (it's the GUI-local odd one out; its note says so).
export const CATEGORIES: Category[] = [
  COMMANDER_CATEGORIES[0],
  THEME_CATEGORY,
  FEATURES_CATEGORY,
  ...COMMANDER_CATEGORIES.slice(1),
];

export const CATEGORY_ICONS: Record<string, string> = {
  general: "⚙",
  theme: "◐",
  sessions: "⧉",
  hibernation: "☾",
  git: "±",
  ai: "✦",
  commander: "◎",
  conversation: "♪",
  stt: "◉",
  telemetry: "◈",
  sections: "▤",
  tui: "❯",
  advanced: "≡",
};
