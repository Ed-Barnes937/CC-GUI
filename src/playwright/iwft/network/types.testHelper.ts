// Shared shapes for the iwft backend fake. The Snapshot family mirrors main.ts
// (which doesn't export its types); the review family is reused from the app's
// own review model so the fake can't drift from what the UI parses.

import type { ReviewSnapshot } from "../../../review/model";

export type SessionRow = {
  id: string;
  title: string;
  branch: string;
  status: string;
  program: string;
  agent_state: string;
  tmux_session_name: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: "open" | "closed" | "merged" | null;
  pr_draft: boolean;
  pr_labels: string[];
  review_decision: string | null;
  has_pending_comments: boolean;
  unread: boolean;
  hibernated: boolean;
  stacked_child: boolean;
  project_id: string;
  project_name: string;
  current_section: string | null;
};

/** One entry in a listed directory, mirroring the backend's FsEntry. */
export type FsEntry = { name: string; is_dir: boolean; size: number };

/** A launch program option, mirroring the backend's ProgramInfo. */
export type ProgramInfo = { label: string; command: string };

export type ProjectGroup = {
  id: string;
  name: string;
  repo_path: string;
  pull_blocked: string | null;
  sessions: SessionRow[];
};

export type Snapshot = {
  groups: ProjectGroup[];
  view_mode: string;
  sections: { name: string; session_ids: string[] }[] | null;
  section_names: string[];
  commander: { enabled: boolean; running: boolean };
};

/** Everything the fake needs to answer a test's backend traffic. Plain data —
 *  it crosses into the page via addInitScript serialization. */
export type Seed = {
  snapshot: Snapshot;
  /** Keyed by session id → the review for that session (answers open_review). */
  reviews: Record<string, ReviewSnapshot>;
  keybindings?: Record<string, string[]>;
  config?: Record<string, unknown>;
  /** Raw custom themes answered to list_custom_themes (validated by theme.ts). */
  customThemes?: unknown[];
  /** Absolute directory paths the fake filesystem "contains" — the source for
   *  complete_path autocomplete. */
  dirs?: string[];
  /** Path the native folder picker (Browse…) returns; null models a cancel. */
  browsePath?: string | null;
  /** The file explorer's fake filesystem: directory contents keyed by path
   *  relative to the session's repo root ("" = root). Answers list_session_dir. */
  fileTree?: Record<string, FsEntry[]>;
  /** The markdown viewer's fake repo: repo-relative .md path → file content.
   *  Answers list_markdown_files / read_session_file. */
  markdownFiles?: Record<string, string>;
  /** Per-session diffstat summary (git shortstat style, e.g. "3 files changed,
   *  124 insertions(+), 38 deletions(-)") — feeds get_session_detail. */
  diffStats?: Record<string, string>;
  /** Configured programs answered by get_create_options. Empty/absent → the
   *  frontend substitutes its built-in fallback set (Claude/Codex/OpenCode).
   *  Note: real CC never returns empty — it synthesizes a single entry equal to
   *  `defaultProgram`; seed that shape to exercise the synthesized-default path. */
  programs?: ProgramInfo[];
  /** default_program answered by get_create_options (defaults to "claude"). */
  defaultProgram?: string;
};
