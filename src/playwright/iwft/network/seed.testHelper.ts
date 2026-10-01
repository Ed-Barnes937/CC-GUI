// Default seed builders. A single project with a single session, and one review
// for that session whose file is plain text (extension not in review.ts's
// EXT_LANG) so Shiki highlighting is skipped — keeping the first scenarios free
// of the async re-tokenize render.

import type { ReviewSnapshot } from "../../../review/model";
import type { ProjectGroup, Seed, SessionRow, Snapshot } from "./types.testHelper";

export const SESSION_ID = "sess-1";

export function makeSession(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    title: "fix login bug",
    branch: "fix/login",
    status: "running",
    program: "claude",
    agent_state: "idle",
    tmux_session_name: "cc-sess-1",
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_draft: false,
    pr_labels: [],
    review_decision: null,
    has_pending_comments: false,
    unread: false,
    hibernated: false,
    stacked_child: false,
    project_id: "proj-1",
    project_name: "acme",
    current_section: null,
    ...over,
  };
}

export function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    groups: [
      {
        id: "proj-1",
        name: "acme",
        repo_path: "/repos/acme",
        pull_blocked: null,
        sessions: [makeSession()],
      },
    ],
    sections: null,
    section_names: [],
    commander: { enabled: false, running: false },
    ...over,
  };
}

export function makeReview(over: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    base: "main",
    diff: {
      files: [
        {
          old_path: "notes.txt",
          new_path: "notes.txt",
          status: "modified",
          added: 2,
          removed: 1,
          hunks: [
            {
              old_start: 1,
              old_lines: 3,
              new_start: 1,
              new_lines: 4,
              header: "",
              lines: [
                { origin: "context", old_lineno: 1, new_lineno: 1, content: "alpha" },
                { origin: "deletion", old_lineno: 2, new_lineno: null, content: "beta old" },
                { origin: "addition", old_lineno: null, new_lineno: 2, content: "beta new" },
                { origin: "addition", old_lineno: null, new_lineno: 3, content: "gamma" },
                { origin: "context", old_lineno: 3, new_lineno: 4, content: "delta" },
              ],
            },
          ],
        },
      ],
    },
    comments: [],
    reviewed: [],
    ...over,
  };
}

export function defaultSeed(): Seed {
  return {
    snapshot: makeSnapshot(),
    reviews: { [SESSION_ID]: makeReview() },
    keybindings: {},
    config: {},
  };
}

/** A project with one session per title. Session ids, branches and tmux names
 *  derive from the project id and title; `workspace` tags the project (absent
 *  = Main). */
export function makeProject(
  id: string,
  name: string,
  titles: string[],
  over: Partial<ProjectGroup> = {},
): ProjectGroup {
  return {
    id,
    name,
    repo_path: `/repos/${name}`,
    pull_blocked: null,
    sessions: titles.map((title, i) =>
      makeSession({
        id: `${id}-s${i + 1}`,
        title,
        branch: title.replace(/\s+/g, "-"),
        tmux_session_name: `cc-${id}-s${i + 1}`,
        project_id: id,
        project_name: name,
      }),
    ),
    ...over,
  };
}

/** Three workspaces, as in the design handoff: Main keeps the default "acme"
 *  project (and its review), "Work" holds two projects and "OSS" one. Both are
 *  defined, in that order; the startup choice is the default "last". */
export function workspacesSeed(): Seed {
  const seed = defaultSeed();
  seed.snapshot.groups.push(
    makeProject("proj-atlas", "atlas-api", ["rate limiter", "auth token refresh"], {
      workspace: "Work",
    }),
    makeProject("proj-web", "web-app", ["billing page"], { workspace: "Work" }),
    makeProject("proj-dot", "dotfiles", ["nvim lsp config"], { workspace: "OSS" }),
  );
  seed.workspaces = { defs: ["Work", "OSS"] };
  return seed;
}
