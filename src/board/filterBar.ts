// The Board's filter bar: the search field, the project multiselect, the
// "hide empty columns" toggle, and the attention pill mirrored from the title
// bar.

import { showContextMenu } from "../menu";
import { noTextAssist } from "../dom";
import { requestRender } from "../app/render";
import { projectPickerItems } from "../session/create";
import { projClass } from "../session/row";
import { createBoardAttentionPill } from "../chrome/attention";
import { boardFilterEl } from "../app/elements";
import { groups } from "../app/store";
import {
  allProjectIds,
  boardSearch,
  hideEmptyColumns,
  selectedProjectIds,
  setBoardProjectFilter,
  setBoardSearch,
  setHideEmptyColumns,
} from "./state";

export function renderBoardFilterBar(): void {
  boardFilterEl.innerHTML = "";

  const pills = document.createElement("div");
  pills.className = "board-pills";

  // Attention summary at the top of the Board, mirroring the title-bar pill
  // (updateTitleBarCounts fills both). Hidden while nothing waits.
  pills.appendChild(createBoardAttentionPill());

  // Toggle: hide section columns with zero visible cards.
  const hideEmpty = document.createElement("button");
  hideEmpty.className = "board-pill hide-empty";
  hideEmpty.textContent = "Hide empty";
  hideEmpty.title = "Hide section columns with no cards";
  hideEmpty.classList.toggle("active", hideEmptyColumns());
  hideEmpty.addEventListener("click", () => {
    setHideEmptyColumns(!hideEmptyColumns());
      renderBoardFilterBar();
    // The rebuild recreated the attention pill blank — refill it now rather
    // than leaving it empty until the next poll snapshot.
    requestRender("titlebar", "board");
  });
  pills.appendChild(hideEmpty);

  const search = noTextAssist(document.createElement("input"));
  search.className = "board-search";
  search.type = "search";
  search.placeholder = "Search sessions…";
  search.value = boardSearch();
  search.addEventListener("input", () => {
    setBoardSearch(search.value);
    requestRender("board");
  });

  const create = document.createElement("button");
  create.className = "board-new primary";
  create.textContent = "＋ New session";
  create.title = "New session";
  create.addEventListener("click", (e) => showContextMenu(e, projectPickerItems()));

  boardFilterEl.append(pills, buildProjectFilter(), search, create);
}

/** Multiselect project filter: a button summarising the selection, over a
 *  popover of per-project checkboxes with Select-all / Clear-all helpers.
 *  Defaults to all projects; the selection lives in `boardProjectFilter`. */
export function buildProjectFilter(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "board-project-filter";

  const btn = document.createElement("button");
  btn.className = "board-pill board-project-btn";
  btn.title = "Filter by project";

  const panel = document.createElement("div");
  panel.className = "board-project-panel hidden";

  const updateSummary = (): void => {
    const total = allProjectIds().length;
    const sel = selectedProjectIds();
    btn.classList.toggle("active", sel.size !== total);
    let label: string;
    if (sel.size === total) label = "All projects";
    else if (sel.size === 0) label = "No projects";
    else if (sel.size === 1) label = groups().find((g) => sel.has(g.id))?.name ?? "1 project";
    else label = `${sel.size} projects`;
    btn.textContent = `${label} ▾`;
  };

  const commit = (next: Set<string> | null): void => {
    setBoardProjectFilter(next && next.size === allProjectIds().length ? null : next);
    updateSummary();
    requestRender("board");
  };

  const rebuildPanel = (): void => {
    panel.innerHTML = "";
    const tools = document.createElement("div");
    tools.className = "board-project-tools";
    const selectAll = document.createElement("button");
    selectAll.className = "board-project-tool";
    selectAll.textContent = "Select all";
    selectAll.addEventListener("click", (e) => {
      e.stopPropagation();
      commit(null);
      rebuildPanel();
    });
    const clearAll = document.createElement("button");
    clearAll.className = "board-project-tool";
    clearAll.textContent = "Clear all";
    clearAll.addEventListener("click", (e) => {
      e.stopPropagation();
      commit(new Set());
      rebuildPanel();
    });
    tools.append(selectAll, clearAll);
    panel.appendChild(tools);

    const selected = selectedProjectIds();
    for (const g of groups()) {
      const row = document.createElement("label");
      row.className = "board-project-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(g.id);
      cb.addEventListener("change", () => {
        const sel = selectedProjectIds();
        if (cb.checked) sel.add(g.id);
        else sel.delete(g.id);
        commit(sel);
      });
      const square = document.createElement("span");
      square.className = `proj-square ${projClass(g.id)}`;
      const name = document.createElement("span");
      name.className = "board-project-name";
      name.textContent = g.name;
      row.append(cb, square, name);
      panel.appendChild(row);
    }
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const close = (): void => {
    panel.classList.add("hidden");
    document.removeEventListener("click", onDocClick, true);
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.classList.contains("hidden")) {
      rebuildPanel();
      panel.classList.remove("hidden");
      document.addEventListener("click", onDocClick, true);
    } else {
      close();
    }
  });

  updateSummary();
  wrap.append(btn, panel);
  return wrap;
}

/** Rebuild the columns from the current snapshot + filter + search. */
