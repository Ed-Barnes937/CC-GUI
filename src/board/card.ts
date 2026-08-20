// A session as a Board card.
//
// The card is the row's parts in a different arrangement: same dot, same
// badges, same context menu, built into a RowRefs so session/row.ts's shared
// menu works unchanged. What's card-specific is the diffstat bar, fetched
// lazily per card because the snapshot doesn't carry it.

import { invoke } from "@tauri-apps/api/core";
import { showContextMenu } from "../menu";
import { draggable } from "../drag";
import { openReview } from "../review";
import { commentsChip, pullBlockedChip } from "../status";
import { lifecycleArgs } from "../app/actions";
import { findSession, groupOf } from "../app/store";
import type { SessionDetail, SessionRow } from "../app/types";
import { openTerminal } from "../terminal/attach";
import { setDockDetached } from "../terminal/surface";
import { diffstatBar, parseDiffStat } from "../session/diffstat";
import { sessionStatusChip } from "../session/glyph";
import { branchMatchesTitle, prBadge, projClass, sessionMenuItems, type RowRefs } from "../session/row";
import { selectRow, selectedSession } from "../session/selection";
import {
  boardCardRefs,
  boardDiffPending,
  boardDiffStats,
  boardStateClass,
  NO_SECTION_KEY,
} from "./state";
import { clearCardDropTargets } from "./columns";

export function ensureBoardDiffStat(id: string, bar: HTMLElement): void {
  if (boardDiffStats.has(id)) {
    fillDiffstatBar(bar, boardDiffStats.get(id) ?? null);
    return;
  }
  if (boardDiffPending.has(id)) return;
  boardDiffPending.add(id);
  invoke<SessionDetail | null>("get_session_detail", { id })
    .then((d) => {
      boardDiffStats.set(id, d?.diff_stat ?? null);
      if (bar.isConnected) fillDiffstatBar(bar, d?.diff_stat ?? null);
    })
    .catch(() => {
      /* transient — leave uncached so a later render retries */
    })
    .finally(() => boardDiffPending.delete(id));
}

/** Render a diffstat into a card's bar: colorized +adds/−dels counts above a
 *  proportional add/remove bar. Mirrors renderDetail's parsing. Omits both when
 *  there is no diff (graceful — never fabricated). */
export function fillDiffstatBar(container: HTMLElement, diffStat: string | null): void {
  container.innerHTML = "";
  const stat = diffStat ? parseDiffStat(diffStat) : null;
  if (!stat || stat.adds + stat.dels === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  const counts = document.createElement("div");
  counts.className = "card-diffcounts";
  const a = document.createElement("span");
  a.className = "added";
  a.textContent = `+${stat.adds}`;
  const r = document.createElement("span");
  r.className = "removed";
  r.textContent = `−${stat.dels}`;
  counts.append(a, r);
  // Bar on top, counts below (the Refined board layout): the proportional bar
  // spans the card, then the +adds/−dels counts sit on their own line and wrap
  // rather than clipping at the column edge.
  container.append(diffstatBar(stat.adds, stat.dels), counts);
}

/** One agent card for a session. */
export function renderAgentCard(s: SessionRow): HTMLDivElement {
  const card = document.createElement("div");
  // State class drives the 3px left accent border (--state-color); in lockstep
  // with the status chip's colour.
  card.className = `agent-card ${boardStateClass(s)}`;
  card.classList.toggle("selected", selectedSession() === s.id);
  boardCardRefs.set(s.id, card);

  // The card is the primary keyboard target: a role=button tile in the board's
  // roving-tabindex group (updateBoardRoving picks which card is tab-focusable;
  // the arrow/Enter handler on #board-columns does the rest). Enter/Space attach.
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${s.title}, ${s.project_name}`);
  card.tabIndex = -1;

  // Drag the card onto another section column to re-pin it. The move commits on
  // release over a column, so an Esc-cancelled drag is a no-op. The card's own
  // click/⋯/▸/± handlers still fire when the pointer doesn't move (no drag).
  card.dataset.id = s.id;
  draggable(card, () => {
    card.classList.add("dragging");
    return {
      onMove(x, y) {
        clearCardDropTargets();
        document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>(".board-col")
          ?.classList.add("card-drop-target");
      },
      onDrop(x, y) {
        const col = document.elementFromPoint(x, y)?.closest<HTMLElement>(".board-col");
        const key = col?.dataset.section;
        if (key === undefined) return;
        // The catch-all column clears the pin (section: null); real columns pin
        // to the section name (dataset.section === the section name).
        const target = key === NO_SECTION_KEY ? null : key;
        if ((findSession(s.id)?.current_section ?? null) === target) return; // no-op drop
        void lifecycleArgs("move_to_section", { id: s.id, section: target });
      },
      onEnd() {
        card.classList.remove("dragging");
        clearCardDropTargets();
      },
    };
  });

  // Header: a title block (session name over its project) + status chip + ⋯
  // menu. Cards now group by section, not project, so the project is named on
  // each card: the session title is primary (h1), the project secondary (h2).
  const header = document.createElement("div");
  header.className = "card-header";
  const heading = document.createElement("div");
  heading.className = "card-heading";
  const name = document.createElement("span");
  name.className = "card-title";
  name.textContent = s.title;
  // The title truncates with an ellipsis, so its tooltip restores the full
  // session name (the branch has its own tooltip on the subtitle below).
  name.title = s.title;
  const project = document.createElement("span");
  project.className = "card-project";
  const square = document.createElement("span");
  square.className = `proj-square ${projClass(s.project_id)}`;
  const projName = document.createElement("span");
  projName.className = "card-project-name";
  projName.textContent = s.project_name;
  project.append(square, projName);
  project.title = s.project_name;
  heading.append(name, project);
  const menu = document.createElement("button");
  menu.className = "row-action card-menu";
  menu.textContent = "⋯";
  menu.title = "Session menu";
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, sessionMenuItems(cardRefs(s)));
  });
  header.append(heading, menu);
  card.appendChild(header);

  // Status chip on its own row under the title — beside the title it crowded
  // long session names into early ellipsis. The 3px left accent border
  // reinforces its colour; the board uses the compact chip variant.
  const chip = sessionStatusChip(s);
  chip.classList.add("compact");
  const statusRow = document.createElement("div");
  statusRow.className = "card-status-row";
  // Non-color cue that this card's terminal is the one docked below — shown by
  // CSS only when the card is `.selected` (the board's docked session). Pairs
  // with the accent outline so the docked state survives grayscale.
  const docked = document.createElement("span");
  docked.className = "card-docked";
  docked.textContent = "▸ docked";
  statusRow.append(chip, docked);
  card.appendChild(statusRow);

  // Branch line under the title — only when it diverges from the title (it's
  // usually just a slug of the name), mirroring the sidebar row. Omitted
  // otherwise to keep cards compact. The PR badge lives in the footer.
  if (!branchMatchesTitle(s.title, s.branch)) {
    const sub = document.createElement("div");
    sub.className = "card-subtitle";
    const branch = document.createElement("span");
    branch.className = "card-branch";
    branch.textContent = s.branch;
    branch.title = `Branch: ${s.branch}`;
    sub.appendChild(branch);
    card.appendChild(sub);
  }

  // Diffstat bar (lazy; hidden until a diff lands).
  const diff = document.createElement("div");
  diff.className = "card-diffstat hidden";
  card.appendChild(diff);
  ensureBoardDiffStat(s.id, diff);

  // Footer: PR badge + ✎/⚠ chips over an always-visible action row of labeled
  // buttons — Attach (accent, the primary action) / ± Review (info). The chips
  // row collapses when empty, so cards without badges lose no vertical budget.
  const footer = document.createElement("div");
  footer.className = "card-footer";
  const chips = document.createElement("span");
  chips.className = "card-chips";
  const prChip = prBadge(s);
  if (prChip) chips.appendChild(prChip);
  if (s.has_pending_comments) {
    chips.appendChild(commentsChip(undefined, "Has pending review comments"));
  }
  const blocked = groupOf(s.id)?.pull_blocked;
  if (blocked) {
    chips.appendChild(pullBlockedChip(`Auto-pull blocked: ${blocked}`));
  }
  const actions = document.createElement("span");
  actions.className = "card-actions";
  // Attach path shared by the ▸ button and a card-body click: select, clear any
  // prior "×" detach, and open the terminal (which docks in board mode).
  const attachCard = (): void => {
    selectRow(s.id);
    setDockDetached(false); // an explicit attach re-docks even after a "×" detach
    void openTerminal(s);
  };
  const attach = document.createElement("button");
  attach.className = "card-action attach";
  attach.textContent = "Attach";
  attach.title = "Attach";
  attach.addEventListener("click", (e) => {
    e.stopPropagation();
    attachCard();
  });
  const review = document.createElement("button");
  review.className = "card-action review";
  review.textContent = "± Review";
  review.title = "Review diff";
  review.addEventListener("click", (e) => {
    e.stopPropagation();
    void openReview(s.id, s.title);
  });
  actions.append(attach, review);
  footer.append(chips, actions);
  card.appendChild(footer);

  // Click attaches (same as ▸); right-click opens the same menu as the ⋯ button.
  // The ▸/±/⋯ buttons stopPropagation, so they never double-trigger this.
  card.addEventListener("click", attachCard);
  card.addEventListener("contextmenu", (e) => showContextMenu(e, sessionMenuItems(cardRefs(s))));
  return card;
}

/** Minimal RowRefs for sessionMenuItems from a card (it reads only .session;
 *  rename routes through the sidebar, which is acceptable on the board). */
export function cardRefs(s: SessionRow): RowRefs {
  return {
    row: document.createElement("div"),
    main: document.createElement("div"),
    actions: document.createElement("div"),
    status: s.status,
    session: s,
  };
}

// Board column order is GUI-owned (like theme/layout prefs): the canonical order
// is the "no section" catch-all first, then sections in their configured order.
// We re-sort client-side from a persisted key list so drag-to-reorder sticks
// across reloads without touching CC config.
