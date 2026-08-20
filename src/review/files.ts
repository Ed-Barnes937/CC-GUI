// The file list down the left: the reviewed-progress ring, a row per changed
// file, and the trailing section for files whose comments outlived their diff.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { displayPath, STATUS_LETTER } from "./model";
import {
  clearSelection,
  filesEl,
  progressEl,
  redraw,
  registerPane,
  reviewed,
  selectedFile,
  sessionId,
  setSelectedFile,
  snapshot,
} from "./state";

/** Toggle the reviewed mark for a file (persisted via the backend) and reflect
 *  it in the local mirror + file list. */
async function toggleReviewed(path: string): Promise<void> {
  if (!sessionId()) return;
  let now: boolean;
  try {
    now = await invoke<boolean>("toggle_file_reviewed", { id: sessionId(), path });
  } catch (e) {
    toast("Couldn't update the reviewed mark.", "error", String(e));
    return;
  }
  if (now) reviewed.add(path);
  else reviewed.delete(path);
  redraw("progress", "files");
}

/** Move the file selection by `delta` (clamped at the ends, no wrap) and keep
 *  the newly selected row visible. Backs the Ctrl-N/P and arrow navigation. */
export function selectFileByOffset(delta: number): void {
  const files = snapshot()?.diff.files;
  if (!files || !files.length) return;
  const cur = files.findIndex((f) => displayPath(f) === selectedFile());
  const next = Math.min(files.length - 1, Math.max(0, (cur === -1 ? 0 : cur) + delta));
  const path = displayPath(files[next]);
  if (path === selectedFile()) return;
  setSelectedFile(path);
  clearSelection();
  redraw("files", "diff");
  filesEl.querySelector(".review-file.active")?.scrollIntoView({ block: "nearest" });
}

/** The "N/total files reviewed" progress ring above the file list, filled
 *  proportionally to the reviewed count. Hidden when there's no diff. */
function renderProgress(): void {
  progressEl.innerHTML = "";
  const files = snapshot()?.diff.files ?? [];
  const total = files.length;
  progressEl.style.display = total ? "" : "none";
  if (!total) return;
  // Count only reviewed paths still present in the diff — the stored set can
  // hold stale paths after a refresh, which would overflow the ring.
  const done = files.filter((f) => reviewed.has(displayPath(f))).length;
  const pct = Math.round((done / total) * 100);

  const wrap = document.createElement("div");
  wrap.className = "review-progress";

  const ring = document.createElement("span");
  ring.className = "progress-ring";
  ring.style.background = `conic-gradient(var(--success) ${pct}%, var(--border) 0)`;
  const count = document.createElement("span");
  count.className = "progress-ring-count";
  count.textContent = `${done}/${total}`;
  ring.appendChild(count);

  const label = document.createElement("span");
  label.className = "progress-label";
  label.textContent = "Files reviewed";

  wrap.append(ring, label);
  progressEl.appendChild(wrap);
}

function renderFiles(): void {
  filesEl.innerHTML = "";
  const snap = snapshot();
  if (!snap) return;
  const commentCounts = new Map<string, number>();
  for (const c of snap.comments) {
    commentCounts.set(c.file, (commentCounts.get(c.file) ?? 0) + 1);
  }
  // Diff files arrive path-sorted, so same-directory files are contiguous:
  // emit a directory header whenever the dirname changes and show basenames.
  let lastDir: string | null = null;
  for (const f of snap.diff.files) {
    const path = displayPath(f);
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    if (dir !== lastDir) {
      lastDir = dir;
      const header = document.createElement("div");
      header.className = "review-dir";
      header.textContent = dir === "" ? "./" : `${dir}/`;
      header.title = header.textContent;
      filesEl.appendChild(header);
    }

    const row = document.createElement("div");
    row.className = "review-file";
    row.classList.toggle("active", path === selectedFile());
    const isReviewed = reviewed.has(path);
    row.classList.toggle("reviewed", isReviewed);

    const tick = document.createElement("span");
    tick.className = "file-reviewed-toggle";
    tick.textContent = isReviewed ? "✓" : "";
    tick.title = isReviewed ? "Mark as not reviewed" : "Mark as reviewed";
    tick.addEventListener("click", (e) => {
      e.stopPropagation(); // toggling reviewed shouldn't also open the diff
      void toggleReviewed(path);
    });

    const status = document.createElement("span");
    status.className = `file-status file-${f.status}`;
    status.textContent = STATUS_LETTER[f.status];

    const name = document.createElement("span");
    name.className = "file-path";
    name.textContent = path.slice(slash + 1);
    name.title = f.status === "renamed" ? `${f.old_path} → ${f.new_path}` : path;

    const counts = document.createElement("span");
    counts.className = "file-counts";
    const comments = commentCounts.get(path);
    if (comments) {
      const c = document.createElement("span");
      c.className = "file-comments";
      c.textContent = `🗨${comments}`;
      counts.appendChild(c);
    }
    const added = document.createElement("span");
    added.className = "added";
    added.textContent = `+${f.added}`;
    const removed = document.createElement("span");
    removed.className = "removed";
    removed.textContent = `-${f.removed}`;
    counts.append(added, removed);

    row.append(tick, status, name, counts);
    row.addEventListener("click", () => {
      setSelectedFile(path);
      clearSelection();
      redraw("files", "diff");
    });
    filesEl.appendChild(row);
  }

  // Files that have comments but are no longer in the diff (their change was
  // reverted) never get a row above, so their comments would be unreachable.
  // List them in a trailing section, keeping them selectable and deletable.
  const diffPaths = new Set(snap.diff.files.map(displayPath));
  const strandedFiles = [...new Set(snap.comments.map((c) => c.file))]
    .filter((p) => !diffPaths.has(p))
    .sort();
  if (strandedFiles.length) {
    const header = document.createElement("div");
    header.className = "review-dir stranded-dir";
    header.textContent = "no longer in the diff";
    header.title = "Files with comments whose change is no longer in the diff";
    filesEl.appendChild(header);
    for (const path of strandedFiles) {
      filesEl.appendChild(strandedFileRow(path, commentCounts.get(path) ?? 0));
    }
  }

  if (!snap.diff.files.length && !strandedFiles.length) {
    const empty = document.createElement("div");
    empty.className = "review-empty";
    empty.textContent = "No changes";
    filesEl.appendChild(empty);
  }
}

/** A file-list row for a path that has comments but is no longer in the diff:
 *  no reviewed toggle or +/- stats (there's no diff), just a marker, the name,
 *  and the comment count. Selecting it renders the stranded comments. */
function strandedFileRow(path: string, count: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "review-file stranded";
  row.classList.toggle("active", path === selectedFile());
  const slash = path.lastIndexOf("/");

  const status = document.createElement("span");
  status.className = "file-status file-stranded";
  status.textContent = "!";

  const name = document.createElement("span");
  name.className = "file-path";
  name.textContent = path.slice(slash + 1);
  name.title = path;

  const counts = document.createElement("span");
  counts.className = "file-counts";
  if (count) {
    const c = document.createElement("span");
    c.className = "file-comments";
    c.textContent = `🗨${count}`;
    counts.appendChild(c);
  }

  row.append(status, name, counts);
  row.addEventListener("click", () => {
    setSelectedFile(path);
    clearSelection();
    redraw("files", "diff");
  });
  return row;
}

registerPane("progress", renderProgress);
registerPane("files", renderFiles);
