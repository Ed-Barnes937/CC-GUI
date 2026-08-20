// A session as a sidebar row, and the stacks rows form.
//
// The row's own parts -- dot, badges, buttons, menu -- come from session/row.ts
// and are shared with the board. What is sidebar-specific lives here: inline
// rename, the drag that moves a row to another section, and the parent/child
// nesting of a stacked session under the one it branched from.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { showContextMenu } from "../menu";
import { draggable } from "../drag";
import { noTextAssist } from "../dom";
import { stackChip } from "../status";
import { sessionsEl } from "../app/elements";
import { requestRender } from "../app/render";
import { invokeToast, lifecycleArgs, refreshNow } from "../app/actions";
import { findSession, maskTitle, unmaskTitle } from "../app/store";
import type { SessionRow } from "../app/types";
import { openTerminal } from "../terminal/attach";
import {
  actionButton,
  buildActions,
  projClass,
  renamingId,
  rowRefs,
  sessionMenuItems,
  setRenamingId,
  updateRow,
  type RowRefs,
} from "../session/row";
import { selectRow } from "../session/selection";

export function renderRenameInput(s: SessionRow): HTMLInputElement {
  const input = noTextAssist(document.createElement("input"));
  input.className = "rename-input";
  input.value = s.title;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      setRenamingId(null);
      requestRender("sidebar");
    }
    if (e.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      setRenamingId(null);
      // Optimistic: show the new title immediately; the mask clears once a
      // snapshot carries the new title (see applyPendingOverlays).
      maskTitle(s.id, title);
      s.title = title;
      invoke("rename_session", { id: s.id, title })
        .then(() => refreshNow())
        .catch((err) => {
          unmaskTitle(s.id); // failed: un-mask so the old title returns
          toast(`rename failed: ${err}`, "error");
          void refreshNow();
        });
      requestRender("sidebar");
    }
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}

export function renderSessionRow(s: SessionRow): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "session-row";
  // Option in the #sessions listbox: keyboard cursor is tracked by the
  // container's aria-activedescendant (updateSelectionClasses), so the row
  // needs a stable DOM id and the option role. aria-selected + aria-label are
  // set from state in updateRow.
  row.id = `row-${s.id}`;
  row.setAttribute("role", "option");
  if (s.stacked_child) row.classList.add("stacked");

  const main = document.createElement("div");
  main.className = "row-main";

  const refs: RowRefs = { row, main, actions: buildActions(s), status: s.status, session: s };
  rowRefs.set(s.id, refs);

  if (renamingId() === s.id) {
    main.appendChild(renderRenameInput(s));
    row.append(main, refs.actions);
    return row;
  }

  row.append(main); // actions land inside main's sub-line via fillRowMain
  row.addEventListener("click", () => {
    selectRow(refs.session.id);
    void openTerminal(refs.session);
  });
  row.addEventListener("contextmenu", (e) => showContextMenu(e, sessionMenuItems(refs)));
  // Draggable onto a section header to re-pin the session (section view only;
  // headers are annotated with dataset.dropSection in renderSections). Not wired
  // in rename mode: that branch returns above.
  row.dataset.id = s.id;
  draggable(row, () => {
    row.classList.add("dragging");
    return {
      onMove(x, y) {
        clearDropTargets();
        const header = document.elementFromPoint(x, y)?.closest<HTMLElement>(".project-header");
        if (header?.dataset.dropSection !== undefined) header.classList.add("drop-target");
      },
      onDrop(x, y) {
        const header = document.elementFromPoint(x, y)?.closest<HTMLElement>(".project-header");
        if (header?.dataset.dropSection === undefined) return;
        // dropSection is "" on the index-0 "In Progress" catch-all: clear the pin.
        const target = header.dataset.dropSection || null;
        const id = refs.session.id;
        if ((findSession(id)?.current_section ?? null) === target) return; // no-op drop
        void lifecycleArgs("move_to_section", { id, section: target });
      },
      onEnd() {
        row.classList.remove("dragging");
        clearDropTargets();
      },
    };
  });
  updateRow(refs, s);
  return row;
}

export type StackUnit =
  | { kind: "single"; session: SessionRow }
  | { kind: "stack"; parent: SessionRow; children: SessionRow[] };

/** Infer cascade stacks from an ordered row list: a non-stacked parent followed
 *  by its consecutive `stacked_child` rows forms one stack (the backend keeps a
 *  stack root + its children contiguous). Children with no preceding parent
 *  (can't happen within one project, but guard anyway) fall back to singles. */
export function groupStacks(rows: SessionRow[]): StackUnit[] {
  const units: StackUnit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    if (s.stacked_child) {
      units.push({ kind: "single", session: s }); // orphan child — render flat
      continue;
    }
    const children: SessionRow[] = [];
    while (i + 1 < rows.length && rows[i + 1].stacked_child) {
      children.push(rows[++i]);
    }
    units.push(children.length ? { kind: "stack", parent: s, children } : { kind: "single", session: s });
  }
  return units;
}

/** A cascade stack: bordered group (faint mauve tint) with a header carrying the
 *  stack name (parent title) and merge/push/⋯ actions, then the parent +
 *  indented child rows (each child gets a project-color left border). */
export function renderStack(parent: SessionRow, children: SessionRow[]): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = `stack ${projClass(parent.project_id)}`;

  const header = document.createElement("div");
  header.className = "stack-header";
  // The ⌗ glyph becomes the labeled "⌗ Stack of N" chip (parent + children),
  // then the parent title names which stack this is.
  const chip = stackChip(children.length + 1, "Cascade stack");
  const name = document.createElement("span");
  name.className = "stack-name";
  name.textContent = parent.title;
  name.title = parent.title;
  header.append(chip, name);

  const actions = document.createElement("span");
  actions.className = "stack-actions";
  const merge = actionButton("⛙", "Cascade-merge main → stack", () =>
    void invokeToast("cascade_merge", { id: parent.id }),
  );
  merge.classList.add("stack-merge");
  const push = actionButton("↑", "Push stack to origin", () =>
    void invokeToast("push_stack", { id: parent.id }),
  );
  push.classList.add("stack-push");
  // ⋯ opens the session menu (resume/abandon live there, gated on cascade_paused)
  // positioned at the click; can't reuse actionButton, which swallows the event.
  const more = document.createElement("button");
  more.className = "row-action";
  more.textContent = "⋯";
  more.title = "Stack actions";
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const refs = rowRefs.get(parent.id);
    if (refs) showContextMenu(e, sessionMenuItems(refs));
  });
  actions.append(merge, push, more);
  header.append(actions);

  wrap.append(header, renderSessionRow(parent));
  for (const c of children) wrap.append(renderSessionRow(c));
  return wrap;
}

/** Drop the section-header highlight from any header still showing it. */
export function clearDropTargets(): void {
  for (const el of sessionsEl.querySelectorAll(".project-header.drop-target")) {
    el.classList.remove("drop-target");
  }
}

/** Refresh a row's dynamic bits without rebuilding it (preserves hover/confirm state). */
