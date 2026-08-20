// The session detail panel: metadata, diffstat, tags and the AI summary.
//
// Opened from a sidebar row, a board card or the keyboard, and refreshed on
// its own 2s timer while open -- the push loop's snapshot carries the list, not
// the per-session detail, so this fetches its own.

import { invoke } from "@tauri-apps/api/core";
import { openReview } from "../review";
import {
  detailChangesEl,
  detailDiffstatEl,
  detailEl,
  detailMetaEl,
  detailPrEl,
  detailReviewEl,
  detailSummaryEl,
  detailTagsEl,
  detailTitleEl,
  summaryGenEl,
} from "../app/elements";
import { groups } from "../app/store";
import type { SessionDetail, SessionRow } from "../app/types";
import { refitActive } from "../terminal/state";
import { diffstatBar, parseDiffStat } from "./diffstat";

let detailId: string | null = null;

/** The session the panel is showing, or null when it's closed. */
export function detailOpenFor(): string | null {
  return detailId;
}
let detailTimer: ReturnType<typeof setInterval> | null = null;
let detailPrUrl: string | null = null; // PR url from the last fetched detail, for the footer

type Summary = { state: "loading" } | { state: "ready"; text: string } | { state: "error"; text: string };
const summaries = new Map<string, Summary>(); // keyed by session id, app-session cache

function metaRow(label: string, value: string): [HTMLElement, HTMLElement] {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
}

/** Update the meta list without rebuilding it when the row shape is unchanged,
 *  so the 2s poll never destroys an in-progress selection of a branch or PR
 *  URL. Full rebuild only when the labels themselves change (PR row appears or
 *  disappears); otherwise touch a `dd`'s text only when its value differs. */
function renderMeta(rows: [string, string][]): void {
  const sameShape =
    detailMetaEl.childElementCount === rows.length * 2 &&
    rows.every(([label], i) => detailMetaEl.children[i * 2].textContent === label);
  if (sameShape) {
    rows.forEach(([, value], i) => {
      const dd = detailMetaEl.children[i * 2 + 1];
      if (dd.textContent !== value) dd.textContent = value;
    });
    return;
  }
  detailMetaEl.innerHTML = "";
  for (const [label, value] of rows) detailMetaEl.append(...metaRow(label, value));
}

function renderDetail(d: SessionDetail): void {
  detailTitleEl.textContent = d.title;
  detailTitleEl.title = d.title; // recover the full string when truncated
  detailPrUrl = d.pr_url;

  const status =
    d.status.toLowerCase() === "running" ? `running · ${d.agent_state}` : d.status.toLowerCase();
  // Order per the brief: branch / (worktree — omitted, not surfaced to the
  // frontend SessionDetail) / PR / status; project/program/created kept.
  const rows: [string, string][] = [["Project", d.project_name], ["Branch", d.branch]];
  if (d.pr_number != null) {
    rows.push([
      "PR",
      `#${d.pr_number} (${d.pr_draft ? "draft" : d.pr_state.toLowerCase()})${d.pr_url ? ` — ${d.pr_url}` : ""}`,
    ]);
  }
  rows.push(["Status", status], ["Program", d.program], ["Created", new Date(d.created_at).toLocaleString()]);
  renderMeta(rows);

  detailDiffstatEl.innerHTML = "";
  const stat = d.diff_stat ? parseDiffStat(d.diff_stat) : null;
  detailChangesEl.textContent =
    stat === null ? "Changes" : `Changes · ${stat.files} file${stat.files === 1 ? "" : "s"}`;
  if (stat) {
    const counts = document.createElement("div");
    counts.className = "diffstat-counts";
    const a = document.createElement("span");
    a.className = "added";
    a.textContent = `+${stat.adds}`;
    const r = document.createElement("span");
    r.className = "removed";
    r.textContent = `−${stat.dels}`;
    counts.append(a, r);
    detailDiffstatEl.appendChild(counts);
    if (stat.adds + stat.dels > 0) detailDiffstatEl.appendChild(diffstatBar(stat.adds, stat.dels));
  } else if (d.diff_stat) {
    // Unrecognized summary shape — show it verbatim rather than dropping it.
    detailDiffstatEl.textContent = d.diff_stat;
  } else {
    detailDiffstatEl.textContent = "No changes";
  }

  // Tag chips: derive from the matching snapshot row's PR labels (real data;
  // no dedicated tag source exists). Empty when the session has no labels.
  detailTagsEl.innerHTML = "";
  const row = groups().flatMap((g) => g.sessions).find((x) => x.id === d.id);
  for (const label of row?.pr_labels ?? []) {
    const chip = document.createElement("span");
    chip.className = "detail-tag";
    chip.textContent = label;
    detailTagsEl.appendChild(chip);
  }

  // Footer: Open PR is enabled only when this session has a PR url.
  detailPrEl.disabled = !d.pr_url;
}

function renderSummary(): void {
  if (!detailId) return;
  const summary = summaries.get(detailId);
  detailSummaryEl.classList.remove("placeholder", "error");
  summaryGenEl.disabled = summary?.state === "loading";
  summaryGenEl.textContent = summary?.state === "ready" ? "↻ Regenerate" : "↻ Generate";
  if (!summary) {
    detailSummaryEl.classList.add("placeholder");
    detailSummaryEl.textContent = "No summary yet — Generate sends the branch diff to Claude.";
  } else if (summary.state === "loading") {
    detailSummaryEl.classList.add("placeholder");
    detailSummaryEl.textContent = "Generating…";
  } else if (summary.state === "error") {
    detailSummaryEl.classList.add("error");
    detailSummaryEl.textContent = summary.text;
  } else {
    detailSummaryEl.textContent = summary.text;
  }
}

export async function generateSummary(): Promise<void> {
  if (!detailId) return;
  const id = detailId;
  if (summaries.get(id)?.state === "loading") return;
  summaries.set(id, { state: "loading" });
  renderSummary();
  try {
    const text = await invoke<string>("generate_summary", { id });
    summaries.set(id, { state: "ready", text });
  } catch (e) {
    summaries.set(id, { state: "error", text: String(e) });
  }
  renderSummary();
}

summaryGenEl.addEventListener("click", () => void generateSummary());

async function refreshDetail(): Promise<void> {
  if (!detailId) return;
  let d: SessionDetail | null = null;
  try {
    d = await invoke<SessionDetail | null>("get_session_detail", { id: detailId });
  } catch {
    return; // transient failure; next tick retries
  }
  if (!detailId) return; // closed while fetching
  if (!d) {
    closeDetail();
    return;
  }
  renderDetail(d);
}

export function closeDetail(): void {
  detailId = null;
  detailPrUrl = null;
  if (detailTimer) clearInterval(detailTimer);
  detailTimer = null;
  detailEl.classList.add("hidden");
  refitActive();
}

export function toggleDetail(s: SessionRow): void {
  if (detailId === s.id) {
    closeDetail();
    return;
  }
  detailId = s.id;
  detailPrUrl = null;
  detailEl.classList.remove("hidden");
  detailTitleEl.textContent = s.title;
  detailMetaEl.innerHTML = "";
  detailChangesEl.textContent = "Changes";
  detailDiffstatEl.textContent = "Loading…";
  detailTagsEl.innerHTML = "";
  detailPrEl.disabled = true;
  renderSummary();
  if (detailTimer) clearInterval(detailTimer);
  detailTimer = setInterval(() => void refreshDetail(), 2000);
  void refreshDetail();
  refitActive();
}

document.querySelector("#detail-close")!.addEventListener("click", closeDetail);
detailReviewEl.addEventListener("click", () => {
  if (detailId) void openReview(detailId, detailTitleEl.textContent ?? "");
});
detailPrEl.addEventListener("click", () => {
  if (detailPrUrl) void invoke("open_external", { url: detailPrUrl });
});
