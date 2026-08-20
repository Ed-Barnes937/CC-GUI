// The Sections tab: a card per section rule, and the encode/decode between the
// UI-friendly drafts and the SectionConfig shape the config stores.
//
// Drafts are mutated in place by their cards -- a card closes over its own draft
// -- so the array only needs replacing when a config is loaded. Structural edits
// (add / remove / move) rebuild the panel and say where focus should land.

import { noTextAssist } from "../dom";
import { redrawPanel, setPendingFocusSelector } from "./state";

// Section rows held as UI-friendly drafts; encoded to SectionConfig on save.
export type Tri = "any" | "yes" | "no";
export type SectionDraft = {
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

/** The section rules being edited. Kept as one array for the life of the app so
 *  cards can close over their own draft; replaced wholesale on load. */
export const sectionDrafts: SectionDraft[] = [];

export function replaceSectionDrafts(next: SectionDraft[]): void {
  sectionDrafts.length = 0;
  sectionDrafts.push(...next);
}

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

export function decodeSections(sections: unknown): SectionDraft[] {
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

export function encodeSections(drafts: SectionDraft[]): Record<string, unknown>[] {
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

export function renderSections(panel: HTMLElement): void {
  const list = document.createElement("div");
  list.className = "section-list";

  sectionDrafts.forEach((draft, i) => list.appendChild(sectionCard(draft, i)));

  const add = document.createElement("button");
  add.className = "row-action section-add";
  add.textContent = "+ Add section";
  add.addEventListener("click", () => {
    sectionDrafts.push(blankSection());
    // Drop the cursor straight into the new section's name field.
    setPendingFocusSelector(`.section-card[data-section-index="${sectionDrafts.length - 1}"] [data-section-field="name"]`);
    redrawPanel();
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
    setPendingFocusSelector(
      remaining === 0
        ? ".section-add"
        : `.section-card[data-section-index="${Math.min(index, remaining - 1)}"] [data-act="del"]`,
    );
    redrawPanel();
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
  setPendingFocusSelector(`.section-card[data-section-index="${j}"] [data-act="${act}"]`);
  redrawPanel();
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
