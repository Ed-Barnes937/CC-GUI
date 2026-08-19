// One session, rendered.
//
// A sidebar row and a board card are two arrangements of the same parts: the
// same status dot, the same PR badge, the same action buttons, the same
// context menu, the same project colour. Both build a RowRefs and hand it to
// the shared menu, so an action added here appears in both without either
// knowing about the other.

import { invoke } from "@tauri-apps/api/core";
import { toast, deleteSessionDialog } from "../toast";
import type { MenuItem } from "../menu";
import { kb } from "../keys";
import { openReview } from "../review";
import { commentsChip, pullBlockedChip } from "../status";
import { sessionsEl } from "../app/elements";
import { requestRender } from "../app/render";
import { actionErrorToast, invokeToast, lifecycle, lifecycleArgs, refreshNow } from "../app/actions";
import {
  groupOf,
  groups,
  maskDeleted,
  sectionNames,
  sections,
  unmaskDeleted,
} from "../app/store";
import type { SessionRow } from "../app/types";
import { activeTerm, terminals } from "../terminal/state";
import { closeTerminal } from "../terminal/surface";
import { openShell, openTerminal } from "../terminal/attach";
import { toggleDetail } from "./detail";
import { sessionStateKey, sessionStateWord, sessionStatusChip, statusGlyph } from "./glyph";
import { selectedSession } from "./selection";

// Which row is in inline-rename mode. It belongs here rather than in the
// sidebar because the menu item that starts a rename is shared with the board.
let renaming: string | null = null;

export function renamingId(): string | null {
  return renaming;
}

export function setRenamingId(id: string | null): void {
  renaming = id;
}

/** Number of project-identity palette slots (--proj-0..--proj-7 in :root). */
export const PROJ_COLORS = 8;

/** Deterministically hash a project_id to one of the PROJ_COLORS palette slots.
 *  FNV-1a over the id so the same project always maps to the same colour. */
export function projIndex(projectId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % PROJ_COLORS;
}

/** CSS class (`proj-N`) carrying a project's identity colour via `--proj-color`.
 *  Consumers read `var(--proj-color)` — never an inline hex. */
export function projClass(projectId: string): string {
  return `proj-${projIndex(projectId)}`;
}

/** Mirror each open tab's status glyph from the latest session snapshot. Tabs
 *  with no matching session (e.g. commander) keep their glyph hidden. */

export function actionButton(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "row-action";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** Destructive actions require a second click within 2.5s. */
export function confirmButton(
  label: string,
  title: string,
  onConfirm: () => void,
): HTMLButtonElement {
  const btn = actionButton(label, title, () => {
    if (btn.classList.contains("confirm")) {
      onConfirm();
    } else {
      btn.classList.add("confirm");
      btn.textContent = "sure?";
      setTimeout(() => {
        btn.classList.remove("confirm");
        btn.textContent = label;
      }, 2500);
    }
  });
  return btn;
}

/** Re-fetch the sidebar snapshot now instead of waiting for the 2s tick. */

export function deleteSession(s: SessionRow): void {
  closeTerminal(s.tmux_session_name);
  maskDeleted(s.id);
  for (const g of groups()) g.sessions = g.sessions.filter((row) => row.id !== s.id);
  const buckets = sections();
  if (buckets) for (const b of buckets) b.session_ids = b.session_ids.filter((id) => id !== s.id);
  requestRender("sidebar");
  requestRender("board");
  requestRender("titlebar");
  invoke("delete_session", { id: s.id })
    .then(() => refreshNow()) // a fresh snapshot confirms absence and clears the mask
    .catch((e) => {
      unmaskDeleted(s.id); // failed: un-mask so the row returns
      actionErrorToast("delete_session", e);
      void refreshNow();
    });
}

export type RowRefs = {
  row: HTMLDivElement;
  main: HTMLDivElement;
  actions: HTMLDivElement;
  status: string;
  session: SessionRow;
};

export const rowRefs = new Map<string, RowRefs>(); // keyed by session id

export function buildActions(s: SessionRow): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.appendChild(actionButton("ⓘ", "Session details", () => toggleDetail(s)));
  actions.appendChild(actionButton("±", "Review diff", () => void openReview(s.id, s.title)));
  if (s.status === "stopped") {
    actions.appendChild(
      actionButton(
        "▶",
        s.hibernated ? "Wake session" : "Restart session",
        () => void lifecycle("restart_session", s.id),
      ),
    );
  }
  if (s.status === "running") {
    actions.appendChild(
      confirmButton("■", "Stop session", () => void lifecycle("kill_session", s.id)),
    );
  }
  actions.appendChild(
    confirmButton("✕", "Delete session (removes worktree + tmux, keeps the branch)", () => deleteSession(s)),
  );
  return actions;
}

/** PR badge: number colored by state, ✓/✗ review decision, draft styling. */
export function prBadge(s: SessionRow): HTMLSpanElement | null {
  if (s.pr_number == null) return null;
  const badge = document.createElement("span");
  badge.className = `pr-badge pr-${s.pr_state ?? "open"}`;
  if (s.pr_draft) badge.classList.add("pr-draft");
  let text = `#${s.pr_number}`;
  if (s.review_decision === "approved") text += " ✓";
  if (s.review_decision === "changes_requested") text += " ✗";
  badge.textContent = text;
  badge.title =
    `PR #${s.pr_number} — ${s.pr_draft ? "draft " : ""}${s.pr_state ?? "open"}` +
    (s.review_decision ? `, ${s.review_decision.replace(/_/g, " ")}` : "") +
    (s.pr_labels.length ? `\nLabels: ${s.pr_labels.join(", ")}` : "");
  return badge;
}

/** True when the branch is just a slug of the title (the common case), so it
 *  carries no information worth its own column. */
export function branchMatchesTitle(title: string, branch: string): boolean {
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug(title) === slug(branch);
}

/** Rebuild the inner content of a row's main span (cheap; no input state).
 *  `actions` is the row's persistent hover-action element (see RowRefs): it's
 *  re-appended at the sub-line's trailing edge so confirm state survives. */
export function fillRowMain(main: HTMLDivElement, s: SessionRow, actions: HTMLDivElement): void {
  main.innerHTML = "";

  // Top line: liveness dot · name · PR badge · right-side chips. The dot is the
  // fast-scan colour at the row's fixed left edge; the labeled word (Running /
  // Done / …) lives on the sub-line so the title gets the full line width.
  const line = document.createElement("div");
  line.className = "row-line";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = s.title;
  title.title = `Branch: ${s.branch}`;
  line.append(statusGlyph(s), title);

  const badge = prBadge(s);
  if (badge) line.appendChild(badge);

  // Right-side chips: ✎ pending comments, ⚠ pull blocked (project-level auto
  // -pull block). Pushed right by .row-chips margin-left:auto.
  const chips = document.createElement("span");
  chips.className = "row-chips";
  // SessionRow carries only has_pending_comments (no count), so the chip reads
  // "✎ Comments" rather than spelling out a number.
  if (s.has_pending_comments) {
    chips.appendChild(commentsChip(undefined, "Has pending review comments"));
  }
  // pull_blocked is a project-level field; surface ⚠ on rows of a blocked
  // project. (No session-level blocked flag exists — see recon risks.)
  const blocked = groupOf(s.id)?.pull_blocked;
  if (blocked) {
    chips.appendChild(pullBlockedChip(`Auto-pull blocked: ${blocked}`));
  }
  if (chips.childElementCount) line.appendChild(chips);

  // Sub-line: the labeled status chip (word-only here — the leading dot already
  // carries shape+colour, so the chip's own dot is hidden by a row-scoped rule),
  // plus the branch when it diverges from the title. SessionRow carries no
  // diff_stat (only SessionDetail does, and we avoid per-row fetches), so the
  // prototype's "+adds −dels" beside the chip has no source on a row.
  const sub = document.createElement("div");
  sub.className = "row-sub";
  sub.appendChild(sessionStatusChip(s));
  if (!branchMatchesTitle(s.title, s.branch)) {
    const branch = document.createElement("span");
    branch.className = "meta";
    branch.textContent = s.branch;
    sub.append(branch);
  }
  // Hover actions ride the sub-line (in line with the status chip) so revealing
  // them doesn't add a line and shift the rows below.
  sub.appendChild(actions);
  main.append(line, sub);
}

export function sessionMenuItems(refs: RowRefs): MenuItem[] {
  const s = refs.session;
  // Core actions, in the order from the design brief.
  const items: MenuItem[] = [
    { label: "Attach", shortcut: kb("select"), action: () => void openTerminal(s) },
    { label: "Open shell", shortcut: kb("select_shell"), action: () => void openShell(s) },
    { label: "Review diff", shortcut: kb("open_review_diff"), action: () => void openReview(s.id, s.title) },
    {
      label: "Rename…",
      shortcut: kb("rename_session"),
      action: () => {
        setRenamingId(s.id);
        requestRender("sidebar");
      },
    },
    "separator",
    {
      label: s.hibernated ? "Wake" : "Restart",
      shortcut: kb("restart_session"),
      action: () => void lifecycle("restart_session", s.id),
    },
    {
      label: "Restart fresh",
      action: () => {
        void invoke("restart_fresh", { tmuxSession: s.tmux_session_name })
          .catch((e) => toast(`restart_fresh failed: ${e}`, "error"))
          .finally(() => void refreshNow());
      },
    },
    {
      label: "Stop",
      sublabel: "stops the process, keeps the worktree",
      warning: true,
      action: () => void lifecycle("kill_session", s.id),
    },
    "separator",
    {
      label: "Delete session…",
      sublabel: "removes worktree + tmux, keeps the branch",
      danger: true,
      shortcut: kb("delete_session"),
      action: () => {
        void deleteSessionDialog(s.title, s.branch).then((ok) => {
          if (ok) deleteSession(s);
        });
      },
    },
  ];

  // Secondary capabilities, preserved below a separator so the rework doesn't
  // drop existing functionality (details, editor, PR, cascade, sections).
  const extras: MenuItem[] = [
    { label: "Details", action: () => toggleDetail(s) },
    { label: "Open in editor", shortcut: kb("open_in_editor"), action: () => void lifecycle("open_in_editor", s.id) },
  ];
  if (s.pr_url) {
    const url = s.pr_url;
    extras.push({
      label: `Open PR #${s.pr_number}`,
      shortcut: kb("open_pull_request"),
      action: () => void invoke("open_external", { url }),
    });
  }
  extras.push({
    label: "Cascade-merge main → stack",
    shortcut: kb("cascade_merge_main"),
    action: () => void invokeToast("cascade_merge", { id: s.id }),
  });
  extras.push({
    label: "Push stack to origin",
    shortcut: kb("push_stack"),
    action: () => void invokeToast("push_stack", { id: s.id }),
  });
  if (s.status === "cascade_paused") {
    extras.push({
      label: "Resume cascade",
      shortcut: kb("cascade_resume"),
      action: () => void invokeToast("cascade_resume", {}),
    });
    extras.push({
      label: "Abandon cascade",
      danger: true,
      shortcut: kb("cascade_abandon"),
      action: () => void invokeToast("cascade_abandon", {}),
    });
  }
  if (sectionNames().length) {
    for (const name of sectionNames()) {
      if (name !== s.current_section) {
        extras.push({
          label: `Move to section: ${name}`,
          action: () => void lifecycleArgs("move_to_section", { id: s.id, section: name }),
        });
      }
    }
    if (s.current_section) {
      extras.push({
        label: "Clear section pin",
        action: () => void lifecycleArgs("move_to_section", { id: s.id, section: null }),
      });
    }
  }

  items.push("separator", ...extras);
  return items;
}

/** Inline rename input shown in place of the row's title. */

export function updateRow(refs: RowRefs, s: SessionRow): void {
  refs.session = s;
  if (renamingId() === s.id) return; // don't clobber the rename input
  if (refs.status !== s.status) {
    refs.actions = buildActions(s);
    refs.status = s.status;
  }
  fillRowMain(refs.main, s, refs.actions);
  refs.row.classList.toggle("active", s.tmux_session_name === activeTerm());
  refs.row.classList.toggle("attached", terminals.has(s.tmux_session_name));
  const sel = s.id === selectedSession();
  refs.row.classList.toggle("selected", sel);
  refs.row.setAttribute("aria-selected", sel ? "true" : "false");
  refs.row.setAttribute("aria-label", `${s.title} — ${sessionStateWord(s, sessionStateKey(s))}`);
  if (sel) sessionsEl.setAttribute("aria-activedescendant", refs.row.id);
}

/** Launch a new session in a project, remembering the chosen harness (if any)
 *  and refreshing once the backend responds. Shared by both create entry points. */
