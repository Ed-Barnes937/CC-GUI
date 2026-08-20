// The shapes the backend pushes to the frontend.
//
// These mirror the serde representations of `claude-commander`'s types as the
// Tauri commands in `src-tauri/src/groups.rs` and `sessions.rs` emit them, so
// field names are snake_case. Every view module renders from these; nothing
// here knows how they're rendered.

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

export type ProjectGroup = {
  id: string;
  name: string;
  repo_path: string;
  pull_blocked: string | null;
  sessions: SessionRow[];
};

export type SectionBucket = { name: string; session_ids: string[] };

/** One push from the backend's polling loop — the whole visible world. */
export type Snapshot = {
  groups: ProjectGroup[];
  sections: SectionBucket[] | null;
  section_names: string[];
  commander: { enabled: boolean; running: boolean };
};

/** The richer per-session record fetched on demand for the detail panel. */
export type SessionDetail = {
  id: string;
  title: string;
  branch: string;
  status: string;
  program: string;
  project_name: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string;
  pr_draft: boolean;
  created_at: string;
  agent_state: string;
  diff_stat: string | null;
};
