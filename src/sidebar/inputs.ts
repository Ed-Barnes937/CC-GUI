// The sidebar's inline text inputs: the per-project "new session" field, and
// the path field at the top for adding or scanning a project.
//
// Both are transient DOM that replaces a header while it's open, and both
// commit on Enter and dismiss on Escape. The path field also completes on Tab
// against the folders the backend reports.

import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "../toast";
import { noTextAssist } from "../dom";
import { createHarnessPicker } from "../harnessPicker";
import { requestRender } from "../app/render";
import { refreshNow } from "../app/actions";
import type { ProjectGroup } from "../app/types";
import { startSession } from "../session/create";
import { setNewSessionProject, setTopInput } from "./state";

export function renderCreateInput(group: ProjectGroup): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "create-input";
  const row = document.createElement("div");
  row.className = "create-input-row";
  const input = noTextAssist(document.createElement("input"));
  input.placeholder = "new session title…";
  const picker = createHarnessPicker(group.repo_path);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // A stray keypress while the harness menu is open closes it, not the input.
      if (picker.isOpen()) {
        picker.closeMenu();
        return;
      }
      setNewSessionProject(null);
      requestRender("sidebar");
    }
    if (e.key === "ArrowDown" && !picker.isOpen()) {
      e.preventDefault();
      picker.openMenu();
    }
    if (e.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      const program = picker.selected() || undefined;
      picker.closeMenu(); // drop the picker's document listener before the re-render
      setNewSessionProject(null);
      input.disabled = true;
      startSession(group, title, program);
    }
  });
  row.append(input, picker.element);
  wrap.appendChild(row);
  setTimeout(() => input.focus(), 0);
  return wrap;
}

/** Longest common prefix of a list of strings (drives Tab completion). */
export function longestCommonPrefix(strings: string[]): string {
  if (!strings.length) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (prefix && !s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

/** Path input at the top of the sidebar for add-project / scan-directory, with
 *  a live directory-completion dropdown (Tab → common prefix, ↑/↓ to pick,
 *  Enter on a match drills in, Enter on free text commits) and a native folder
 *  picker via "Browse…". Seeded with `~/` so the first listing shows $HOME. */
export function renderTopInput(mode: "add" | "scan"): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "create-input path-input";
  const row = document.createElement("div");
  row.className = "path-input-row";
  const input = noTextAssist(document.createElement("input"));
  input.placeholder = mode === "add" ? "path to git repo…" : "directory to scan for repos…";
  input.value = "~/";
  const browse = document.createElement("button");
  browse.className = "path-browse";
  browse.textContent = "Browse…";
  const listEl = document.createElement("div");
  listEl.className = "path-completions";
  row.append(input, browse);
  wrap.append(row, listEl);

  let completions: string[] = [];
  let selected = -1; // -1 = nothing highlighted (Enter commits the typed value)
  let debounce: number | undefined;

  function renderCompletions(): void {
    listEl.innerHTML = "";
    completions.forEach((c, i) => {
      const r = document.createElement("div");
      r.className = "path-completion";
      r.classList.toggle("selected", i === selected);
      r.textContent = c;
      // mousedown (not click) so the pick lands before the input's blur.
      r.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = `${c}/`;
        selected = -1;
        void refresh();
        input.focus();
      });
      listEl.appendChild(r);
    });
  }

  async function refresh(): Promise<void> {
    let next: string[];
    try {
      next = await invoke<string[]>("complete_path", { partial: input.value });
    } catch {
      next = [];
    }
    completions = next;
    selected = completions.length ? Math.min(selected, completions.length - 1) : -1;
    renderCompletions();
  }

  function commit(path: string): void {
    setTopInput(null);
    input.disabled = true;
    const call =
      mode === "add"
        ? invoke("add_project", { path })
        : invoke<{ added: number; skipped: number }>("scan_directory", { path }).then((r) =>
            toast(`Scan complete: ${r.added} added, ${r.skipped} already present`),
          );
    call
      .catch((err) => toast(`${mode === "add" ? "add project" : "scan"} failed: ${err}`, "error"))
      .finally(() => void refreshNow());
    requestRender("sidebar");
  }

  input.addEventListener("input", () => {
    selected = -1;
    clearTimeout(debounce);
    debounce = window.setTimeout(() => void refresh(), 100);
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      setTopInput(null);
      requestRender("sidebar");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (completions.length) {
        selected = (selected + 1) % completions.length;
        renderCompletions();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (completions.length) {
        selected = selected <= 0 ? completions.length - 1 : selected - 1;
        renderCompletions();
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const lcp = longestCommonPrefix(completions);
      if (lcp && lcp.length > input.value.length) {
        input.value = lcp;
        void refresh();
      }
      return;
    }
    if (e.key === "Enter") {
      // A highlighted row drills into that directory; otherwise commit the
      // typed path (the "I typed the full path, just add it" case).
      if (selected >= 0 && completions[selected]) {
        input.value = `${completions[selected]}/`;
        selected = -1;
        void refresh();
      } else if (input.value.trim()) {
        commit(input.value.trim());
      }
    }
  });

  browse.addEventListener("click", () => {
    void openFolderDialog({ directory: true }).then((picked) => {
      if (typeof picked === "string") {
        input.value = picked;
        input.focus();
        void refresh();
      }
    });
  });

  setTimeout(() => {
    input.focus();
    void refresh();
  }, 0);
  return wrap;
}
