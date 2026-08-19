// What the sidebar is currently showing, apart from the sessions themselves:
// which group headers are collapsed, which project header has its create-input
// open, which path input is up, and which project the list is filtered to.
//
// It sits below the render modules so they can share it without importing each
// other, and behind accessors so a stray assignment can't leave the sidebar
// showing one thing and believing another.

import { requestRender } from "../app/render";
import {
  sectionNames,
  setStatusGrouping,
  setViewModePref,
  statusGrouping,
  viewMode,
} from "../app/store";

// Key of the project header with an open create-input. In project view this is
// the bare project id; in section view it's scoped to the section (see
// `sectionCreateKey`) so the same project across sections opens independently.
let createOpenFor: string | null = null;

export function newSessionProject(): string | null {
  return createOpenFor;
}

export function setNewSessionProject(key: string | null): void {
  createOpenFor = key;
}
let pathInput: "add" | "scan" | null = null;

/** Which path input the sidebar top is showing ("add" a project, or "scan" a
 *  folder for repos), or null for neither. */
export function topInput(): "add" | "scan" | null {
  return pathInput;
}

export function setTopInput(mode: "add" | "scan" | null): void {
  pathInput = mode;
}
// Project the session list is filtered to (toggled from the projects rail), or
// null for "all projects". Composes with whichever grouping is active.
let filter: string | null = null;

export function projectFilter(): string | null {
  return filter;
}

export function setProjectFilter(id: string | null): void {
  filter = id;
}

/** Create-input key for a project sub-header inside a section. The `sect:`
 *  prefix can't collide with a bare project uuid (project-view key). */
export const sectionCreateKey = (section: string, projectId: string): string =>
  `sect:${section}\x00${projectId}`;

// Collapsed sidebar groups ("proj:<id>" / "sect:<name>"), persisted.
const collapsed = new Set<string>(
  JSON.parse(localStorage.getItem("cc-collapsed") ?? "[]") as string[],
);

export function isCollapsed(key: string): boolean {
  return collapsed.has(key);
}

/** Expand a group without persisting -- used when something must become
 *  visible (a create-input opening inside a collapsed project). */
export function expandGroup(key: string): void {
  collapsed.delete(key);
}

/** The collapse state as a stable string, for the render signature. */
export function collapsedSignature(): string {
  return [...collapsed].sort().join(",");
}

export function toggleCollapsed(key: string): void {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  localStorage.setItem("cc-collapsed", JSON.stringify([...collapsed]));
  requestRender("sidebar");
}

/** Chevron + collapse-toggling click handler for a group header. */
export function makeCollapsible(header: HTMLDivElement, name: HTMLSpanElement, key: string): boolean {
  const isCollapsed = collapsed.has(key);
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = isCollapsed ? "▸ " : "▾ ";
  name.prepend(chevron);
  header.classList.add("collapsible");
  header.addEventListener("click", () => toggleCollapsed(key));
  return isCollapsed;
}

/** A thin subtle hairline that grows to fill the rest of a group header row
 *  (after the name + count), trailing off toward the edge. */
export function headerRule(): HTMLSpanElement {
  const rule = document.createElement("span");
  rule.className = "header-rule";
  return rule;
}

export function applyViewMode(mode: string): void {
  if ((mode === "sections" || mode === "section_stacks") && sectionNames().length === 0) {
    mode = "project";
  }
  setViewModePref(mode);
  requestRender("sidebar");
}

export function cycleViewMode(): void {
  // Backend grouping modes, then the GUI-only Status stop. Section modes drop
  // out of the cycle when no sections are configured.
  const modes = sectionNames().length ? ["project", "sections", "section_stacks"] : ["project"];
  if (statusGrouping()) {
    // Status (GUI-only) is the cycle's last stop; leaving it restarts at the top.
    setStatusGrouping(false);
    applyViewMode(modes[0]);
    return;
  }
  const idx = modes.indexOf(viewMode());
  if (idx === modes.length - 1) {
    setStatusGrouping(true);
    return;
  }
  applyViewMode(modes[idx + 1]);
}

/** Switch grouping to an explicit mode (the GROUP BY segmented control). */
export function setViewMode(mode: string): void {
  setStatusGrouping(false); // leaving the GUI-only Status override, if it's on
  if (mode === viewMode()) return;
  applyViewMode(mode);
}

/** GROUP BY segmented control: [Sections | Projects | Status]. Sections and
 *  Projects are bound to viewMode (Projects→"project", Sections→"sections";
 *  "section_stacks" still counts as the Sections side and stays reachable via
 *  the palette's cycleViewMode). Status is the GUI-only tier grouping and
 *  overrides whichever viewMode sits underneath. */
