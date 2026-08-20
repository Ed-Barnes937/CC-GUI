// Drawing the session list.
//
// One render function, re-run whenever the snapshot or a preference changes,
// with a signature check that skips the rebuild when nothing visible differs --
// a full rebuild would drop an open create-input or a rename mid-edit.
//
// Three groupings share it: by project, by section bucket, or by activity tier
// (the GUI-only "Status" override). Each produces the same rows.

import { showContextMenu } from "../menu";
import { cycleSession } from "../commands";
import { openTerminal } from "../terminal/attach";
import { registerView } from "../app/render";
import { sessionsEl } from "../app/elements";
import {
  findSession,
  groups,
  setStatusGrouping,
  sectionView,
  sections,
  statusGrouping,
  viewMode,
} from "../app/store";
import type { ProjectGroup, SectionBucket, SessionRow } from "../app/types";
import { STATUS_TIERS, pullBlockedChip, type StatusTier } from "../status";
import { openProjectShell } from "../terminal/attach";
import { sessionTier } from "../session/glyph";
import { projClass, renamingId, rowRefs, updateRow } from "../session/row";
import {
  onSelectionChange,
  pushVisibleRows,
  resetVisibleRows,
  selectedSession,
} from "../session/selection";
import { createSessionInProject, projectPickerItems } from "../session/create";
import { renderCreateInput, renderTopInput } from "./inputs";
import { projectMenuItems, sidebarMenuItems } from "./menus";
import { groupStacks, renderSessionRow, renderStack } from "./rows";
import {
  collapsedSignature,
  expandGroup,
  setNewSessionProject,
  makeCollapsible,
  headerRule,
  newSessionProject,
  projectFilter,
  sectionCreateKey,
  setProjectFilter,
  setViewMode,
  topInput,
} from "./state";

let sidebarSignature = "";

/**
 * Rebuild the sidebar DOM only when its structure (projects, session set/order,
 * open create-input) changes; otherwise patch rows in place. A periodic full
 * rebuild would wipe the create-input text and confirm-button state every tick.
 */
export function renderGroupByBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "group-by-bar";
  const label = document.createElement("span");
  label.className = "group-by-label";
  label.textContent = "GROUP BY";

  const seg = document.createElement("div");
  seg.className = "segmented";
  const sectionsActive = !statusGrouping() && (viewMode() === "sections" || viewMode() === "section_stacks");

  const sectionsBtn = document.createElement("button");
  sectionsBtn.className = "segment";
  sectionsBtn.textContent = "Sections";
  sectionsBtn.classList.toggle("active", sectionsActive);
  sectionsBtn.addEventListener("click", () => setViewMode("sections"));

  const projectsBtn = document.createElement("button");
  projectsBtn.className = "segment";
  projectsBtn.textContent = "Projects";
  projectsBtn.classList.toggle("active", !statusGrouping() && !sectionsActive);
  projectsBtn.addEventListener("click", () => setViewMode("project"));

  const statusBtn = document.createElement("button");
  statusBtn.className = "segment";
  statusBtn.textContent = "Status";
  statusBtn.classList.toggle("active", statusGrouping());
  statusBtn.addEventListener("click", () => setStatusGrouping(true));

  seg.append(sectionsBtn, projectsBtn, statusBtn);
  bar.append(label, seg);
  return bar;
}

/** Banner shown when a project filter is active, with a clear affordance. */
export function renderFilterBanner(group: ProjectGroup): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "filter-banner";
  const square = document.createElement("span");
  square.className = `proj-square ${projClass(group.id)}`;
  const text = document.createElement("span");
  text.className = "filter-text";
  text.textContent = `filtered to ${group.name}`;
  const clear = document.createElement("button");
  clear.className = "row-action";
  clear.textContent = "✕";
  clear.title = "Clear project filter";
  clear.addEventListener("click", () => {
    setProjectFilter(null);
    renderSidebar();
  });
  banner.append(square, text, clear);
  return banner;
}

/** Render section-grouped views: section headers with rows looked up by id. */
export function renderSections(buckets: SectionBucket[]): void {
  const projById = new Map(groups().map((g) => [g.id, g]));
  buckets.forEach((bucket, bucketIndex) => {
    // Compose with the project filter: only the filtered project's ids survive.
    const ids = projectFilter()
      ? bucket.session_ids.filter((id) => findSession(id)?.project_id === projectFilter())
      : bucket.session_ids;
    const header = document.createElement("div");
    header.className = "project-header";
    const name = document.createElement("span");
    name.textContent = bucket.name;
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = String(ids.length);
    header.append(name, count, headerRule());
    const isCollapsed = makeCollapsible(header, name, `sect:${bucket.name}`);
    // Annotate as a session drop target for the row drag (see renderRow): "" on
    // the index-0 "In Progress" catch-all clears the pin, else the section name.
    header.dataset.dropSection = bucketIndex === 0 ? "" : bucket.name;
    sessionsEl.appendChild(header);
    if (isCollapsed) return;

    // Cluster the section's sessions by project, preserving first-seen project
    // order and within-project order — a stack never spans projects, so its
    // root and indented children stay contiguous.
    const order: string[] = [];
    const byProject = new Map<string, SessionRow[]>();
    for (const id of ids) {
      const s = findSession(id);
      if (!s) continue;
      let rows = byProject.get(s.project_id);
      if (!rows) {
        rows = [];
        byProject.set(s.project_id, rows);
        order.push(s.project_id);
      }
      rows.push(s);
    }

    for (const pid of order) {
      const rows = byProject.get(pid)!;
      const group = projById.get(pid);
      if (group) {
        sessionsEl.appendChild(renderProjectSubheader(group, bucket.name));
        if (newSessionProject() === sectionCreateKey(bucket.name, group.id)) {
          sessionsEl.appendChild(renderCreateInput(group));
        }
      }
      renderRows(rows);
      pushVisibleRows(rows.map((s) => s.id));
    }
  });
}

/** A project sub-header shown inside a section bucket: names the project and
 *  carries the same new-session affordances as the real project header. Not a
 *  drop target — only section headers accept dropped sessions. */
export function renderProjectSubheader(group: ProjectGroup, sectionName: string): HTMLDivElement {
  const key = sectionCreateKey(sectionName, group.id);
  const header = document.createElement("div");
  header.className = "project-subheader";
  const name = document.createElement("span");
  name.textContent = group.name;
  const add = document.createElement("button");
  add.className = "row-action";
  add.textContent = "+";
  add.title = "New session in this project";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    setNewSessionProject(newSessionProject() === key ? null : key);
    renderSidebar();
  });
  const buttons = document.createElement("span");
  buttons.className = "header-buttons";
  buttons.append(add);
  header.append(name, buttons);
  header.addEventListener("contextmenu", (e) =>
    showContextMenu(e, projectMenuItems(group, key)),
  );
  return header;
}

export function renderSidebar(): void {
  const signature =
    groups()
      .map((g) => `${g.id}@${g.pull_blocked}:${g.sessions.map((s) => s.id).join(",")}`)
      .join("|") +
    `#${newSessionProject()}#${renamingId()}#${topInput()}#${viewMode()}#${projectFilter()}` +
    `#${sections()?.map((b) => `${b.name}=${b.session_ids.join(",")}`).join("|") ?? ""}` +
    // Status grouping: tier membership must force a rebuild (a status flip has
    // to move the row between tiers, which updateRow alone can't do).
    `#${statusGrouping() ? "status:" + groups().flatMap((g) => g.sessions.map((s) => `${s.id}=${sessionTier(s)}`)).join(",") : ""}` +
    `#${collapsedSignature()}`;

  if (signature === sidebarSignature) {
    for (const group of groups()) {
      for (const s of group.sessions) {
        const refs = rowRefs.get(s.id);
        if (refs) updateRow(refs, s);
      }
    }
    return;
  }

  sidebarSignature = signature;
  rowRefs.clear();
  resetVisibleRows();
  sessionsEl.innerHTML = "";
  const pathInput = topInput();
  if (pathInput) {
    sessionsEl.appendChild(renderTopInput(pathInput));
  }

  // Grouping control, shown in every view.
  sessionsEl.appendChild(renderGroupByBar());

  // When a project filter is active, show a banner with a clear affordance.
  const filterGroup = projectFilter() ? groups().find((g) => g.id === projectFilter()) : undefined;
  if (filterGroup) {
    sessionsEl.appendChild(renderFilterBanner(filterGroup));
  }

  // The GUI-only Status grouping overrides whichever view mode is active.
  if (statusGrouping()) {
    sessionsEl.appendChild(renderNewSessionButton());
    renderStatusTiers();
    return;
  }

  const buckets = sections();
  if (sectionView() && buckets) {
    sessionsEl.appendChild(renderNewSessionButton());
    renderSections(buckets);
    return;
  }

  for (const group of groups()) {
    if (projectFilter() && group.id !== projectFilter()) continue;
    const header = document.createElement("div");
    header.className = "project-header";
    const square = document.createElement("span");
    square.className = `proj-square ${projClass(group.id)}`;
    const name = document.createElement("span");
    name.textContent = group.name;
    // ⚠ pull-blocked chip sits beside the name (its own header child so it gets
    // the row gap and escapes the header's uppercase transform).
    const blockedChip = group.pull_blocked
      ? pullBlockedChip(`Auto-pull of main blocked: ${group.pull_blocked}`)
      : null;
    const buttons = document.createElement("span");
    buttons.className = "header-buttons";
    const shell = document.createElement("button");
    shell.className = "row-action";
    shell.textContent = "$";
    shell.title = "Project shell";
    shell.addEventListener("click", (e) => {
      e.stopPropagation();
      void openProjectShell(group);
    });
    const add = document.createElement("button");
    add.className = "row-action";
    add.textContent = "+";
    add.title = "New session in this project";
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      setNewSessionProject(newSessionProject() === group.id ? null : group.id);
      expandGroup(`proj:${group.id}`); // the create input must be visible
      renderSidebar();
    });
    buttons.append(shell, add);
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = String(group.sessions.length);
    header.append(square, name, count);
    if (blockedChip) header.append(blockedChip);
    header.append(headerRule(), buttons);
    const isCollapsed = makeCollapsible(header, name, `proj:${group.id}`);
    header.addEventListener("contextmenu", (e) => showContextMenu(e, projectMenuItems(group)));
    sessionsEl.appendChild(header);
    if (isCollapsed) continue;

    if (newSessionProject() === group.id) {
      sessionsEl.appendChild(renderCreateInput(group));
    }
    if (!group.sessions.length && projectFilter() === group.id) {
      sessionsEl.appendChild(renderEmptyProject(group));
      continue;
    }
    renderRows(group.sessions);
    pushVisibleRows(group.sessions.map((s) => s.id));
  }
}

// The sidebar redraws on request rather than by direct call, so a terminal
// exit or a board action can ask for it without importing it.
registerView("sidebar", renderSidebar);

// The sidebar draws the keyboard cursor on its rows, and mirrors it to the
// listbox's aria-activedescendant so assistive tech follows the same row.
onSelectionChange(() => {
  const id = selectedSession();
  for (const [rowId, refs] of rowRefs) {
    const sel = rowId === id;
    refs.row.classList.toggle("selected", sel);
    refs.row.setAttribute("aria-selected", sel ? "true" : "false");
  }
  sessionsEl.setAttribute("aria-activedescendant", id ? `row-${id}` : "");
  if (id) rowRefs.get(id)?.row.scrollIntoView({ block: "nearest" });
});

/** Full-width create button for groupings without project headers (section and
 *  status views): pick any project (incl. sessionless ones), then a title. */
export function renderNewSessionButton(): HTMLButtonElement {
  const newBtn = document.createElement("button");
  newBtn.className = "new-session-btn";
  newBtn.textContent = "+ New session";
  newBtn.addEventListener("click", (e) => showContextMenu(e, projectPickerItems()));
  return newBtn;
}

/** Render the GUI-only Status grouping: sessions bucketed into coarse activity
 *  tiers (Needs you / Active / Parked; see stateTier). Tier membership only
 *  changes on meaningful events — a turn ending, a session stopped or resumed —
 *  never on the working ⇄ idle flicker, so rows don't shuffle underneath the
 *  user. Within a tier, rows cluster by project in snapshot order (mirroring
 *  renderSections). Empty tiers are hidden. Tier headers are not section drop
 *  targets: status changes machine-side, so there's nothing to drag onto. */
export function renderStatusTiers(): void {
  const buckets = new Map<StatusTier, SessionRow[]>();
  for (const g of groups()) {
    if (projectFilter() && g.id !== projectFilter()) continue;
    for (const s of g.sessions) {
      const tier = sessionTier(s);
      let rows = buckets.get(tier);
      if (!rows) {
        rows = [];
        buckets.set(tier, rows);
      }
      rows.push(s);
    }
  }

  const projById = new Map(groups().map((g) => [g.id, g]));
  for (const { tier, label } of STATUS_TIERS) {
    const tierRows = buckets.get(tier);
    if (!tierRows?.length) continue;
    const header = document.createElement("div");
    // tier-* lets the "Needs you" tier read as the list's peak (see CSS); the
    // other tiers keep the plain group-header treatment.
    header.className = `project-header tier-${tier}`;
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = String(tierRows.length);
    header.append(name, count, headerRule());
    const isCollapsed = makeCollapsible(header, name, `tier:${tier}`);
    sessionsEl.appendChild(header);
    if (isCollapsed) continue;

    // Cluster the tier's sessions by project, preserving snapshot order.
    const order: string[] = [];
    const byProject = new Map<string, SessionRow[]>();
    for (const s of tierRows) {
      let rows = byProject.get(s.project_id);
      if (!rows) {
        rows = [];
        byProject.set(s.project_id, rows);
        order.push(s.project_id);
      }
      rows.push(s);
    }

    for (const pid of order) {
      const rows = byProject.get(pid)!;
      const group = projById.get(pid);
      if (group) {
        sessionsEl.appendChild(renderProjectSubheader(group, label));
        if (newSessionProject() === sectionCreateKey(label, group.id)) {
          sessionsEl.appendChild(renderCreateInput(group));
        }
      }
      renderRows(rows);
      pushVisibleRows(rows.map((s) => s.id));
    }
  }
}

/** Render an ordered row list, folding consecutive stacked_child rows into a
 *  bordered stack group. Shared by both groupings. */
export function renderRows(rows: SessionRow[]): void {
  for (const unit of groupStacks(rows)) {
    if (unit.kind === "stack") {
      sessionsEl.appendChild(renderStack(unit.parent, unit.children));
    } else {
      sessionsEl.appendChild(renderSessionRow(unit.session));
    }
  }
}

/** Empty-project state shown when filtered to a project with no sessions: a
 *  dashed "＋" tile plus new-session / shell affordances (reusing the rail's
 *  backend wiring). */
export function renderEmptyProject(group: ProjectGroup): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "empty-project";
  const tile = document.createElement("div");
  tile.className = "empty-tile";
  tile.textContent = "＋";
  const msg = document.createElement("div");
  msg.className = "empty-msg";
  msg.textContent = `No sessions in ${group.name} yet`;
  const actions = document.createElement("div");
  actions.className = "empty-actions";
  const create = document.createElement("button");
  create.className = "row-action";
  create.textContent = "＋ New session";
  create.addEventListener("click", () => void createSessionInProject(group));
  const shell = document.createElement("button");
  shell.className = "row-action";
  shell.textContent = "$ Shell";
  shell.addEventListener("click", () => void openProjectShell(group));
  actions.append(create, shell);
  block.append(tile, msg, actions);
  return block;
}

document.querySelector<HTMLButtonElement>("#sidebar-menu")!.addEventListener("click", (e) => {
  showContextMenu(e, sidebarMenuItems());
});

// Native listbox navigation when the sidebar list itself holds focus: bare
// ↑/↓ walk the cursor and Enter opens, matching the ARIA listbox pattern for
// keyboard/AT users. The global Cmd+Opt+↑/↓ chords still work regardless of
// focus; this only adds the standard interaction when #sessions is focused.
sessionsEl.addEventListener("keydown", (e) => {
  if (e.metaKey || e.altKey || e.ctrlKey) return; // don't shadow the chords
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cycleSession(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cycleSession(-1);
  } else if (e.key === "Enter" && selectedSession()) {
    e.preventDefault();
    const s = findSession(selectedSession()!);
    if (s) void openTerminal(s);
  }
});
