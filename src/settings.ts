// Settings modal: a categorized, typed editor behind a single searchable nav.
//
// One nav lists every category: the claude-commander Config ones (round-tripped
// through `save_config`) plus the GUI-only ones — Appearance (theming) and
// Features (optional-feature switches) — which apply live to localStorage and
// never touch `save_config`. The search box filters categories by their label
// and their fields' labels/descriptions.
//
// Config categories are schema-driven: each field declares a control (toggle,
// number, select, string-list, …) and a dot-path into the config. On save we
// deep-clone the loaded config and overwrite only the edited leaves, so keys we
// don't render (keybindings, theme overrides) survive untouched.

import { invoke } from "@tauri-apps/api/core";
import { toast, confirmDialog } from "./toast";
import { noTextAssist } from "./dom";
import { getMode, setMode, type Mode } from "./theme";
import { openThemeModal } from "./theme/modal";
import { allFeatures, isEnabled, setEnabled } from "./features";

type Config = Record<string, unknown>;

// ----------------------------------------------------------------- schema

type SelectOption = { value: string; label: string };

type Control =
  | { kind: "toggle" }
  | { kind: "number"; min?: number; max?: number; step?: number; unit?: string }
  | { kind: "number-nullable"; min?: number; max?: number; unit?: string }
  | { kind: "text"; placeholder?: string }
  | { kind: "path"; placeholder?: string }
  | { kind: "nullable"; placeholder?: string }
  | { kind: "select"; options: SelectOption[] }
  | { kind: "tristate-null"; auto: string; on: string; off: string }
  | { kind: "string-list"; placeholder?: string };

type Field = {
  path: string;
  label: string;
  desc?: string;
  control: Control;
  /** Only editable when this boolean path is `true` (master-toggle gating). */
  enabledBy?: string;
};

type Category =
  | { id: string; label: string; fields: Field[]; note?: string }
  | { id: string; label: string; custom: "sections"; note?: string }
  | { id: string; label: string; custom: "theme"; note?: string }
  | { id: string; label: string; custom: "features"; note?: string };

const COMMANDER_CATEGORIES: Category[] = [
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

const THEME_CATEGORY: Category = {
  id: "theme",
  label: "Appearance",
  custom: "theme",
  note: "Theme preferences are stored locally for this GUI and don't affect the claude-commander config.",
};

const FEATURES_CATEGORY: Category = {
  id: "features",
  label: "Features",
  custom: "features",
  note: "Optional parts of this GUI you can switch off. Like theme preferences, these are stored locally and don't affect the claude-commander config. Changes apply immediately.",
};

// One nav for everything: Appearance sits with the config categories, right
// after General (it's the GUI-local odd one out; its note says so).
const CATEGORIES: Category[] = [
  COMMANDER_CATEGORIES[0],
  THEME_CATEGORY,
  FEATURES_CATEGORY,
  ...COMMANDER_CATEGORIES.slice(1),
];

const CATEGORY_ICONS: Record<string, string> = {
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

// ----------------------------------------------------------------- state

let working: Config = {};
let activeCat = "general";
let searchQuery = "";

// Section rows held as UI-friendly drafts; encoded to SectionConfig on save.
type Tri = "any" | "yes" | "no";
type SectionDraft = {
  name: string;
  prState: Set<string>;
  isDraft: Tri;
  hasLabel: string; // comma-separated
  hasPr: Tri;
  reviewDecision: Set<string>;
  reviewer: "any" | "yes" | "no" | "specific";
  reviewerLogins: string; // comma-separated, only when reviewer === "specific"
  maxSessions: string;
};
let sectionDrafts: SectionDraft[] = [];

// ----------------------------------------------------------------- dom shell

const overlay = document.createElement("div");
overlay.id = "settings-overlay";
overlay.classList.add("hidden");
const box = document.createElement("div");
box.className = "settings-box";
box.setAttribute("role", "dialog");
box.setAttribute("aria-modal", "true");
box.setAttribute("aria-label", "Settings");
overlay.appendChild(box);
document.body.appendChild(overlay);

// The config the pane last loaded (as it would be saved), so we can tell whether
// there are unsaved edits before discarding them. Set on open.
let originalJson = "";
// The Save button, held so save feedback can disable/relabel it in flight.
let saveBtn: HTMLButtonElement | null = null;
// When a structural re-render (add/move/remove section) should land focus on a
// specific control afterward, its selector goes here for renderPanel to honor.
let pendingFocusSelector: string | null = null;

/** A stable DOM id for a config field's control, so its <label> can point at it
 *  and focus can be restored to it across a panel rebuild. */
function fieldId(path: string): string {
  return "set-" + path.replace(/[^\w-]/g, "-");
}

// ----------------------------------------------------------------- path helpers

function getPath(obj: Config, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o && typeof o === "object") return (o as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function setPath(obj: Config, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] == null || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[last] = value;
}

// ----------------------------------------------------------------- controls

/** Build the control element for a schema field, wiring change → `working`. */
function makeControl(field: Field): HTMLElement {
  const { path, control } = field;
  const value = getPath(working, path);
  let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

  switch (control.kind) {
    case "toggle": {
      const wrap = document.createElement("label");
      wrap.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = fieldId(path);
      input.checked = value === true;
      input.dataset.key = path;
      input.dataset.kind = "toggle";
      input.addEventListener("change", () => {
        setPath(working, path, input.checked);
        // Master toggles gate other fields — re-render so they enable/disable.
        if (categoryGatesOn(path)) renderPanel();
      });
      const slider = document.createElement("span");
      slider.className = "slider";
      wrap.append(input, slider);
      return wrap;
    }
    case "number":
    case "number-nullable": {
      const input = document.createElement("input");
      input.type = "number";
      if (control.min !== undefined) input.min = String(control.min);
      if (control.max !== undefined) input.max = String(control.max);
      if ("step" in control && control.step !== undefined) input.step = String(control.step);
      input.value = value == null ? "" : String(value);
      input.dataset.key = path;
      input.dataset.kind = control.kind;
      input.addEventListener("input", () => {
        const raw = input.value.trim();
        if (raw === "") {
          if (control.kind === "number-nullable") setPath(working, path, null);
          return; // required numbers keep their last value until blur normalizes
        }
        const n = Number(raw);
        if (!Number.isNaN(n)) setPath(working, path, n);
      });
      // Normalize on blur so a stored value never silently diverges from the
      // field: clamp out-of-range numbers to the min/max, and snap a blanked or
      // unparseable required field back to the value actually stored.
      input.addEventListener("blur", () => {
        const raw = input.value.trim();
        const stored = getPath(working, path);
        if (raw === "" || Number.isNaN(Number(raw))) {
          if (raw === "" && control.kind === "number-nullable") {
            setPath(working, path, null);
            input.value = "";
          } else {
            input.value = stored == null ? "" : String(stored);
          }
          return;
        }
        let n = Number(raw);
        if (control.min !== undefined && n < control.min) n = control.min;
        if (control.max !== undefined && n > control.max) n = control.max;
        input.value = String(n);
        setPath(working, path, n);
      });
      el = input;
      break;
    }
    case "select": {
      const select = document.createElement("select");
      for (const opt of control.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.value = value == null ? "" : String(value);
      select.dataset.key = path;
      select.dataset.kind = "select";
      select.addEventListener("change", () => setPath(working, path, select.value));
      el = select;
      break;
    }
    case "tristate-null": {
      const select = document.createElement("select");
      const opts: { v: string; l: string }[] = [
        { v: "auto", l: control.auto },
        { v: "on", l: control.on },
        { v: "off", l: control.off },
      ];
      for (const { v, l } of opts) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        select.appendChild(o);
      }
      select.value = value === true ? "on" : value === false ? "off" : "auto";
      select.dataset.key = path;
      select.dataset.kind = "select";
      select.addEventListener("change", () => {
        setPath(working, path, select.value === "on" ? true : select.value === "off" ? false : null);
      });
      el = select;
      break;
    }
    case "string-list": {
      const area = noTextAssist(document.createElement("textarea"));
      area.value = Array.isArray(value) ? (value as unknown[]).map(String).join("\n") : "";
      area.rows = Math.min(6, Math.max(2, (Array.isArray(value) ? value.length : 0) + 1));
      area.placeholder = control.placeholder ?? "";
      area.dataset.key = path;
      area.dataset.kind = "string-list";
      area.addEventListener("input", () => {
        const list = area.value.split("\n").map((s) => s.trim()).filter(Boolean);
        setPath(working, path, list);
      });
      el = area;
      break;
    }
    default: {
      // text | path | nullable
      const input = noTextAssist(document.createElement("input"));
      input.type = "text";
      input.value = value == null ? "" : String(value);
      input.placeholder = control.placeholder ?? "";
      input.dataset.key = path;
      input.dataset.kind = control.kind;
      input.addEventListener("input", () => {
        const v = input.value;
        if (control.kind === "text") setPath(working, path, v);
        else setPath(working, path, v.trim() === "" ? null : v);
      });
      el = input;
    }
  }

  el.id = fieldId(path);
  if (field.enabledBy && getPath(working, field.enabledBy) !== true) {
    el.disabled = true;
  }
  return el;
}

/** Whether toggling `path` should re-render (because some field is gated by it). */
function categoryGatesOn(path: string): boolean {
  const cat = CATEGORIES.find((c) => c.id === activeCat);
  if (!cat || !("fields" in cat)) return false;
  return cat.fields.some((f) => f.enabledBy === path);
}

// ----------------------------------------------------------------- render

/** Categories whose label — or any field label/description — matches the
 *  search query. All of them when the query is blank. */
function visibleCategories(): Category[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return CATEGORIES;
  return CATEGORIES.filter((cat) => {
    if (cat.label.toLowerCase().includes(q)) return true;
    if (!("fields" in cat)) return false;
    return cat.fields.some(
      (f) => f.label.toLowerCase().includes(q) || (f.desc ?? "").toLowerCase().includes(q),
    );
  });
}

function render(): void {
  box.innerHTML = "";

  const body = document.createElement("div");
  body.className = "settings-body";

  const nav = document.createElement("div");
  nav.className = "settings-nav";

  const title = document.createElement("div");
  title.className = "settings-nav-title";
  title.textContent = "Settings";

  const search = noTextAssist(document.createElement("input"));
  search.type = "text";
  search.className = "settings-search";
  search.placeholder = "⌕ Search settings…";
  search.setAttribute("aria-label", "Search settings");
  search.value = searchQuery;
  search.addEventListener("input", () => {
    searchQuery = search.value;
    renderNav(navList);
    renderPanel();
  });

  const navList = document.createElement("div");
  navList.className = "settings-nav-list";
  navList.addEventListener("keydown", (e) => onNavKeydown(e, navList));
  renderNav(navList);

  nav.append(title, search, navList);

  const panel = document.createElement("div");
  panel.className = "settings-panel";
  body.append(nav, panel);
  box.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "editor-buttons";
  const cancel = document.createElement("button");
  cancel.className = "row-action";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => void requestClose());
  const save = document.createElement("button");
  save.className = "row-action";
  save.textContent = "Save";
  save.addEventListener("click", () => void saveSettings());
  saveBtn = save;
  footer.append(cancel, save);
  box.appendChild(footer);

  renderPanel();
  // Land keyboard focus in the search box so the whole pane is reachable by
  // typing or arrowing from the first keystroke.
  setTimeout(() => search.focus(), 0);
}

/** Roving keyboard navigation for the category nav: arrows and Home/End move
 *  focus between categories, and a printable key jumps to the next category
 *  whose label starts with it (type-ahead). Enter/Space activate natively. */
function onNavKeydown(e: KeyboardEvent, navList: HTMLElement): void {
  const items = [...navList.querySelectorAll<HTMLElement>(".settings-nav-item")];
  if (items.length === 0) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    items[cur < 0 ? 0 : Math.min(items.length - 1, cur + 1)].focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    items[cur <= 0 ? 0 : cur - 1].focus();
  } else if (e.key === "Home") {
    e.preventDefault();
    items[0].focus();
  } else if (e.key === "End") {
    e.preventDefault();
    items[items.length - 1].focus();
  } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const ch = e.key.toLowerCase();
    for (let k = 1; k <= items.length; k++) {
      const it = items[((cur < 0 ? 0 : cur) + k) % items.length];
      // The label is the text node after the icon span (see renderNav).
      if ((it.lastChild?.textContent ?? "").trim().toLowerCase().startsWith(ch)) {
        e.preventDefault();
        it.focus();
        break;
      }
    }
  }
}

/** Fill the nav list with the categories matching the current search. When the
 *  active category is filtered out, the first match becomes active. */
function renderNav(navList: HTMLElement): void {
  navList.innerHTML = "";
  const cats = visibleCategories();
  if (cats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-nav-empty";
    empty.textContent = "No matches";
    navList.appendChild(empty);
    return;
  }
  if (!cats.some((c) => c.id === activeCat)) activeCat = cats[0].id;
  for (const cat of cats) {
    const item = document.createElement("button");
    item.className = "settings-nav-item";
    const isActive = cat.id === activeCat;
    item.classList.toggle("active", isActive);
    if (isActive) item.setAttribute("aria-current", "true");
    const icon = document.createElement("span");
    icon.className = "settings-nav-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = CATEGORY_ICONS[cat.id] ?? "·";
    item.append(icon, document.createTextNode(cat.label));
    item.dataset.cat = cat.id;
    item.addEventListener("click", () => {
      activeCat = cat.id;
      renderNav(navList);
      renderPanel();
      // Keep focus on the now-active category so arrow-nav and type-ahead can
      // continue from here after a keyboard (Enter/Space) activation.
      navList.querySelector<HTMLElement>(".settings-nav-item.active")?.focus();
    });
    navList.appendChild(item);
  }
}

/** A selector that re-finds the focused control after a panel rebuild, plus its
 *  caret, or null when focus is outside the panel (nothing to preserve). */
type PanelFocus = { sel: string; start: number | null; end: number | null };

function capturePanelFocus(panel: HTMLElement): PanelFocus | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !panel.contains(el)) return null;
  let sel: string | null = null;
  if (el.id) {
    sel = `#${CSS.escape(el.id)}`;
  } else {
    const field = el.getAttribute("data-section-field");
    const idx = el.closest<HTMLElement>(".section-card")?.dataset.sectionIndex;
    if (field && idx != null) {
      sel = `.section-card[data-section-index="${idx}"] [data-section-field="${field}"]`;
    }
  }
  if (!sel) return null;
  let start: number | null = null;
  let end: number | null = null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      start = end = null; // number/range inputs forbid selection access
    }
  }
  return { sel, start, end };
}

function restorePanelFocus(panel: HTMLElement, desc: PanelFocus | null): void {
  if (!desc) return;
  const el = panel.querySelector<HTMLElement>(desc.sel);
  if (!el) return;
  el.focus();
  if (desc.start != null && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    try {
      el.setSelectionRange(desc.start, desc.end ?? desc.start);
    } catch {
      /* number/range inputs forbid setSelectionRange */
    }
  }
}

/** Re-render just the content panel (nav/footer stay). Keyboard focus is
 *  preserved across the rebuild: an explicit `pendingFocusSelector` wins,
 *  otherwise the previously-focused control is re-found and re-focused. */
function renderPanel(): void {
  const panel = box.querySelector<HTMLElement>(".settings-panel");
  if (!panel) return;
  const captured = capturePanelFocus(panel);
  panel.innerHTML = "";
  // A search with no matches empties the panel too — otherwise the nav says
  // "No matches" while the previously-active category keeps rendering.
  if (visibleCategories().length === 0) return;
  const cat = CATEGORIES.find((c) => c.id === activeCat);
  if (!cat) return;
  const restore = () => {
    const desc = pendingFocusSelector ? { sel: pendingFocusSelector, start: null, end: null } : captured;
    pendingFocusSelector = null;
    restorePanelFocus(panel, desc);
  };

  const heading = document.createElement("div");
  heading.className = "settings-panel-heading";
  heading.textContent = cat.label;
  panel.appendChild(heading);

  if (cat.note) {
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = cat.note;
    panel.appendChild(note);
  }

  if ("custom" in cat) {
    if (cat.custom === "sections") renderSections(panel);
    else if (cat.custom === "features") renderFeatures(panel);
    else renderTheme(panel);
    restore();
    return;
  }

  for (const field of cat.fields) {
    const row = document.createElement("div");
    row.className = "settings-field";
    if (field.enabledBy && getPath(working, field.enabledBy) !== true) {
      row.classList.add("disabled");
    }
    const head = document.createElement("div");
    head.className = "settings-field-head";
    const label = document.createElement("label");
    label.className = "settings-field-label";
    label.htmlFor = fieldId(field.path);
    label.textContent = field.label;
    head.appendChild(label);
    if (field.desc) {
      const desc = document.createElement("div");
      desc.className = "settings-field-desc";
      desc.textContent = field.desc;
      head.appendChild(desc);
    }
    const control = makeControl(field);
    row.append(head, control);
    panel.appendChild(row);
  }
  restore();
}

// -------------------------------------------------------------- features tab

/** One switch per registered optional feature. Writes straight through to the
 *  registry (localStorage) rather than the config draft, so these rows are
 *  outside the Save/Cancel flow — same as the appearance controls. */
function renderFeatures(panel: HTMLElement): void {
  const features = allFeatures();
  if (features.length === 0) {
    const empty = document.createElement("p");
    empty.className = "settings-note";
    empty.textContent = "No optional features are available in this build.";
    panel.appendChild(empty);
    return;
  }

  for (const f of features) {
    const row = document.createElement("div");
    row.className = "settings-field";
    const head = document.createElement("div");
    head.className = "settings-field-head";
    const label = document.createElement("label");
    label.className = "settings-field-label";
    label.htmlFor = fieldId(`feature.${f.id}`);
    label.textContent = f.name;
    const desc = document.createElement("div");
    desc.className = "settings-field-desc";
    desc.textContent = f.desc;
    head.append(label, desc);

    const wrap = document.createElement("label");
    wrap.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = fieldId(`feature.${f.id}`);
    input.checked = isEnabled(f.id);
    input.addEventListener("change", () => setEnabled(f.id, input.checked));
    const slider = document.createElement("span");
    slider.className = "slider";
    wrap.append(input, slider);

    row.append(head, wrap);
    panel.appendChild(row);
  }
}

// ----------------------------------------------------------------- theme tab

function renderTheme(panel: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "settings-field";
  const head = document.createElement("div");
  head.className = "settings-field-head";
  const label = document.createElement("label");
  label.className = "settings-field-label";
  label.textContent = "Appearance";
  head.appendChild(label);
  const desc = document.createElement("div");
  desc.className = "settings-field-desc";
  desc.textContent = "Follow the OS, or force light/dark.";
  head.appendChild(desc);

  const seg = document.createElement("div");
  seg.className = "settings-segment";
  const modes: { v: Mode; l: string }[] = [
    { v: "system", l: "System" },
    { v: "light", l: "Light" },
    { v: "dark", l: "Dark" },
  ];
  for (const { v, l } of modes) {
    const b = document.createElement("button");
    b.textContent = l;
    b.dataset.mode = v;
    b.classList.toggle("active", getMode() === v);
    b.addEventListener("click", () => {
      setMode(v);
      for (const sib of seg.querySelectorAll("button")) {
        sib.classList.toggle("active", sib === b);
      }
    });
    seg.appendChild(b);
  }
  row.append(head, seg);
  panel.appendChild(row);

  const themesRow = document.createElement("div");
  themesRow.className = "settings-field";
  const th = document.createElement("div");
  th.className = "settings-field-head";
  const tl = document.createElement("label");
  tl.className = "settings-field-label";
  tl.textContent = "Themes";
  th.appendChild(tl);
  const td = document.createElement("div");
  td.className = "settings-field-desc";
  td.textContent = "Pick the theme used for each appearance, with live preview.";
  th.appendChild(td);

  const actions = document.createElement("div");
  actions.className = "settings-theme-actions";
  const dark = document.createElement("button");
  dark.className = "row-action";
  dark.textContent = "Dark theme…";
  dark.addEventListener("click", () => {
    closeSettings();
    openThemeModal("dark");
  });
  const light = document.createElement("button");
  light.className = "row-action";
  light.textContent = "Light theme…";
  light.addEventListener("click", () => {
    closeSettings();
    openThemeModal("light");
  });
  const folder = document.createElement("button");
  folder.className = "row-action";
  folder.textContent = "Open themes folder…";
  folder.addEventListener("click", () => void invoke("open_themes_dir").catch((e) => toast(`${e}`, "error")));
  actions.append(dark, light, folder);
  themesRow.append(th, actions);
  panel.appendChild(themesRow);
}

// ----------------------------------------------------------------- sections editor

const PR_STATES = ["open", "closed", "merged"];
const REVIEW_DECISIONS = ["review_required", "approved", "changes_requested"];

function blankSection(): SectionDraft {
  return {
    name: "",
    prState: new Set(),
    isDraft: "any",
    hasLabel: "",
    hasPr: "any",
    reviewDecision: new Set(),
    reviewer: "any",
    reviewerLogins: "",
    maxSessions: "",
  };
}

/** A list value from config: `"x"` → ["x"], `["x","y"]` → [...], else []. */
function asList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return (v as unknown[]).map(String);
  return [];
}

function triFromBool(v: unknown): Tri {
  return v === true ? "yes" : v === false ? "no" : "any";
}

function decodeSections(sections: unknown): SectionDraft[] {
  if (!Array.isArray(sections)) return [];
  return (sections as Record<string, unknown>[]).map((s) => {
    const reviewer = s.has_reviewer;
    const reviewerLogins = asList(reviewer);
    return {
      name: typeof s.name === "string" ? s.name : "",
      prState: new Set(asList(s.pr_state)),
      isDraft: triFromBool(s.is_draft),
      hasLabel: asList(s.has_label).join(", "),
      hasPr: triFromBool(s.has_pr),
      reviewDecision: new Set(asList(s.review_decision)),
      reviewer: reviewer === true ? "yes" : reviewer === false ? "no" : reviewerLogins.length ? "specific" : "any",
      reviewerLogins: reviewerLogins.join(", "),
      maxSessions: typeof s.max_sessions === "number" ? String(s.max_sessions) : "",
    };
  });
}

/** Single value → scalar, many → array, none → omit. */
function packList(list: string[]): unknown {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return list;
}

function parseCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function encodeSections(drafts: SectionDraft[]): Record<string, unknown>[] {
  return drafts.map((d) => {
    const out: Record<string, unknown> = { name: d.name.trim() };
    const prState = packList([...d.prState]);
    if (prState !== undefined) out.pr_state = prState;
    if (d.isDraft !== "any") out.is_draft = d.isDraft === "yes";
    const label = packList(parseCsv(d.hasLabel));
    if (label !== undefined) out.has_label = label;
    if (d.hasPr !== "any") out.has_pr = d.hasPr === "yes";
    const decision = packList([...d.reviewDecision]);
    if (decision !== undefined) out.review_decision = decision;
    if (d.reviewer === "yes") out.has_reviewer = true;
    else if (d.reviewer === "no") out.has_reviewer = false;
    else if (d.reviewer === "specific") {
      const logins = packList(parseCsv(d.reviewerLogins));
      if (logins !== undefined) out.has_reviewer = logins;
    }
    const max = Number(d.maxSessions.trim());
    if (d.maxSessions.trim() !== "" && !Number.isNaN(max)) out.max_sessions = max;
    return out;
  });
}

function renderSections(panel: HTMLElement): void {
  const list = document.createElement("div");
  list.className = "section-list";

  sectionDrafts.forEach((draft, i) => list.appendChild(sectionCard(draft, i)));

  const add = document.createElement("button");
  add.className = "row-action section-add";
  add.textContent = "+ Add section";
  add.addEventListener("click", () => {
    sectionDrafts.push(blankSection());
    // Drop the cursor straight into the new section's name field.
    pendingFocusSelector = `.section-card[data-section-index="${sectionDrafts.length - 1}"] [data-section-field="name"]`;
    renderPanel();
  });

  panel.append(list, add);
}

function sectionCard(draft: SectionDraft, index: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.sectionIndex = String(index);

  const header = document.createElement("div");
  header.className = "section-card-header";
  const name = noTextAssist(document.createElement("input"));
  name.type = "text";
  name.className = "section-name";
  name.placeholder = "Section name";
  name.value = draft.name;
  name.dataset.sectionField = "name";
  name.addEventListener("input", () => (draft.name = name.value));

  const tools = document.createElement("div");
  tools.className = "section-tools";
  const up = iconBtn("↑", "Move section up", "up", index === 0, () => moveSection(index, -1));
  const down = iconBtn("↓", "Move section down", "down", index === sectionDrafts.length - 1, () => moveSection(index, 1));
  const del = iconBtn("✕", "Remove section", "del", false, () => {
    sectionDrafts.splice(index, 1);
    // Land focus on a remaining card's remove button, or the add button if the
    // list is now empty.
    const remaining = sectionDrafts.length;
    pendingFocusSelector = remaining === 0
      ? ".section-add"
      : `.section-card[data-section-index="${Math.min(index, remaining - 1)}"] [data-act="del"]`;
    renderPanel();
  });
  tools.append(up, down, del);
  header.append(name, tools);
  card.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "section-grid";

  grid.append(
    fieldLabel("PR state"),
    checkboxSet(PR_STATES, draft.prState),
    fieldLabel("Draft"),
    triSelect(draft.isDraft, (v) => (draft.isDraft = v)),
    fieldLabel("Has label"),
    csvInput(draft.hasLabel, "ready-for-review, blocked", (v) => (draft.hasLabel = v), "has_label"),
    fieldLabel("Has PR"),
    triSelect(draft.hasPr, (v) => (draft.hasPr = v)),
    fieldLabel("Review decision"),
    checkboxSet(REVIEW_DECISIONS, draft.reviewDecision),
    fieldLabel("Reviewer"),
    reviewerControl(draft),
    fieldLabel("WIP limit"),
    maxSessionsInput(draft),
  );

  card.appendChild(grid);
  return card;
}

function moveSection(index: number, delta: number): void {
  const j = index + delta;
  if (j < 0 || j >= sectionDrafts.length) return;
  [sectionDrafts[index], sectionDrafts[j]] = [sectionDrafts[j], sectionDrafts[index]];
  // Keep focus on the arrow that moved; when it lands on a boundary (and so
  // disables), fall back to the opposite arrow at the new position.
  const act = delta < 0 ? (j === 0 ? "down" : "up") : (j === sectionDrafts.length - 1 ? "up" : "down");
  pendingFocusSelector = `.section-card[data-section-index="${j}"] [data-act="${act}"]`;
  renderPanel();
}

function iconBtn(glyph: string, label: string, act: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "section-icon";
  b.textContent = glyph;
  b.setAttribute("aria-label", label);
  b.dataset.act = act;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function fieldLabel(text: string): HTMLElement {
  const l = document.createElement("span");
  l.className = "section-field-label";
  l.textContent = text;
  return l;
}

function checkboxSet(values: string[], selected: Set<string>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "section-checks";
  for (const v of values) {
    const lab = document.createElement("label");
    lab.className = "section-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(v);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(v);
      else selected.delete(v);
    });
    lab.append(cb, document.createTextNode(v));
    wrap.appendChild(lab);
  }
  return wrap;
}

function triSelect(value: Tri, onChange: (v: Tri) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [v, l] of [["any", "Any"], ["yes", "Yes"], ["no", "No"]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value as Tri));
  return sel;
}

function csvInput(value: string, placeholder: string, onChange: (v: string) => void, field: string): HTMLInputElement {
  const input = noTextAssist(document.createElement("input"));
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.dataset.sectionField = field;
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function reviewerControl(draft: SectionDraft): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "section-reviewer";
  const sel = document.createElement("select");
  for (const [v, l] of [["any", "Any"], ["yes", "Has reviewer"], ["no", "No reviewer"], ["specific", "Specific…"]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    sel.appendChild(o);
  }
  sel.value = draft.reviewer;
  const logins = csvInput(draft.reviewerLogins, "login1, login2", (v) => (draft.reviewerLogins = v), "reviewer_logins");
  logins.hidden = draft.reviewer !== "specific";
  sel.addEventListener("change", () => {
    draft.reviewer = sel.value as SectionDraft["reviewer"];
    logins.hidden = draft.reviewer !== "specific";
  });
  wrap.append(sel, logins);
  return wrap;
}

function maxSessionsInput(draft: SectionDraft): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.value = draft.maxSessions;
  input.placeholder = "(none)";
  input.dataset.sectionField = "max_sessions";
  input.addEventListener("input", () => (draft.maxSessions = input.value));
  // Normalize on blur: a WIP limit is a whole number ≥ 1, so clamp anything
  // lower and drop an unparseable entry rather than storing it.
  input.addEventListener("blur", () => {
    const raw = input.value.trim();
    if (raw === "") return;
    const n = Number(raw);
    input.value = draft.maxSessions = Number.isNaN(n) ? "" : String(Math.max(1, Math.floor(n)));
  });
  return input;
}

// ----------------------------------------------------------------- save / open

/** The working config as it would be persisted, with section drafts encoded. */
function snapshotForSave(): Config {
  return { ...working, sections: encodeSections(sectionDrafts) };
}

/** Whether the pane holds edits that have not been saved. */
function isDirty(): boolean {
  return JSON.stringify(snapshotForSave()) !== originalJson;
}

async function saveSettings(): Promise<void> {
  // Flush a focused field's pending blur-normalization first: Cmd/Ctrl+Enter can
  // fire while a number input still holds focus and an out-of-range value.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const snapshot = snapshotForSave();
  const btn = saveBtn;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  try {
    const restartRequired = await invoke<boolean>("save_config", { config: snapshot });
    originalJson = JSON.stringify(snapshot);
    closeSettings();
    toast(
      restartRequired
        ? "Settings saved. Some changes take effect after restarting the app."
        : "Settings saved.",
    );
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save";
    }
    toast("Couldn't save settings.", "error", String(e));
  }
}

export async function openSettings(): Promise<void> {
  let config: Config;
  try {
    config = await invoke<Config>("get_config");
  } catch (e) {
    toast(`failed to load config: ${e}`, "error");
    return;
  }
  working = structuredClone(config);
  sectionDrafts = decodeSections(working.sections);
  activeCat = CATEGORIES[0].id;
  searchQuery = "";
  originalJson = JSON.stringify(snapshotForSave());
  render();
  overlay.classList.remove("hidden");
}

function closeSettings(): void {
  overlay.classList.add("hidden");
}

/** Close the pane, but guard unsaved edits behind a discard confirmation. */
async function requestClose(): Promise<void> {
  if (isDirty()) {
    const discard = await confirmDialog("Discard unsaved changes?", "Discard");
    if (!discard) return;
  }
  closeSettings();
}

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) void requestClose();
});
box.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter saves from anywhere in the pane.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void saveSettings();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.classList.contains("hidden")) void requestClose();
});
