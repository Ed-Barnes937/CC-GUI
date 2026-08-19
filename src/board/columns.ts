// The Board's columns: their order, the drag that reorders them, and the
// roving focus that walks cards with the keyboard.
//
// Column order is GUI-owned like the theme and layout prefs -- a section the
// backend adds later keeps its canonical position until the user moves it.

import { draggable } from "../drag";
import { requestRender } from "../app/render";
import { boardColumnsEl } from "../app/elements";
import { selectedSession } from "../session/selection";
import { renderAgentCard } from "./card";
import {
  boardCardRefs,
  boardSectionColumns,
  type BoardSection,
} from "./state";

const BOARD_ORDER_KEY = "cc-board-col-order";
export function loadBoardOrder(): string[] {
  try {
    const raw = localStorage.getItem(BOARD_ORDER_KEY);
    return Array.isArray(JSON.parse(raw ?? "")) ? (JSON.parse(raw!) as string[]) : [];
  } catch {
    return [];
  }
}
export let boardColOrder = loadBoardOrder();

/** Section columns re-sorted by the persisted column order. Columns absent from
 *  the saved order (new sections) keep their canonical position, after the
 *  ranked ones — Array.sort is stable, so unranked relative order is preserved. */
export function orderedSectionColumns(): BoardSection[] {
  const rank = new Map(boardColOrder.map((key, i) => [key, i] as const));
  return [...boardSectionColumns()].sort(
    (a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity),
  );
}

/** The column to drop before, given the pointer's x (null = past the last). */
export function colBeforeX(x: number): HTMLElement | null {
  const cols = [...boardColumnsEl.querySelectorAll<HTMLElement>(".board-col:not(.dragging)")];
  for (const c of cols) {
    const r = c.getBoundingClientRect();
    if (x < r.left + r.width / 2) return c;
  }
  return null;
}

/** Insertion marker, mirroring the tab strip: an accent line on the edge where
 *  the dragged column will land (left for "before", right of the last for end). */
export function showColDropMarker(target: HTMLElement | null): void {
  clearColDropMarker();
  if (target) {
    target.classList.add("drop-before");
  } else {
    const cols = boardColumnsEl.querySelectorAll<HTMLElement>(".board-col:not(.dragging)");
    cols[cols.length - 1]?.classList.add("drop-after");
  }
}
export function clearColDropMarker(): void {
  for (const c of boardColumnsEl.querySelectorAll(".board-col.drop-before, .board-col.drop-after")) {
    c.classList.remove("drop-before", "drop-after");
  }
}

/** Remove the card-drop highlight from every column. */
export function clearCardDropTargets(): void {
  for (const c of boardColumnsEl.querySelectorAll(".board-col.card-drop-target")) {
    c.classList.remove("card-drop-target");
  }
}

// ── Board keyboard navigation ──────────────────────────────────────────────
// The board is a roving-tabindex group: exactly one card is tab-focusable, so
// Tab lands on a card; arrows then move focus across cards and columns, and
// Enter/Space attaches. Roving *focus* is distinct from *selection* — the
// `.selected`/docked card (see selectRow) — so browsing the board never docks a
// session until you press Enter.
export let boardFocusId: string | null = null;

export function boardCards(): HTMLDivElement[] {
  return [...boardColumnsEl.querySelectorAll<HTMLDivElement>(".agent-card")];
}

/** Give exactly one card `tabIndex 0` — the docked card if visible, else the
 *  last-focused card, else the first — so Tab enters the board on a sensible
 *  card. Called after every column rebuild. */
export function updateBoardRoving(): void {
  const cards = boardCards();
  const chosen =
    (selectedSession() ? boardCardRefs.get(selectedSession()!) : undefined) ??
    (boardFocusId ? boardCardRefs.get(boardFocusId) : undefined) ??
    cards[0];
  for (const c of cards) c.tabIndex = c === chosen ? 0 : -1;
  boardFocusId = chosen?.dataset.id ?? boardFocusId;
}

/** Move roving focus to `card`, updating the tabindex so it stays the entry
 *  point, then focus it. */
export function focusBoardCard(card: HTMLDivElement | undefined): void {
  if (!card) return;
  for (const c of boardCards()) c.tabIndex = c === card ? 0 : -1;
  boardFocusId = card.dataset.id ?? null;
  card.focus();
}

/** Focus the card nearest `rowIdx` in the first non-empty column found stepping
 *  `dir` from `colIdx` (skips empty columns). */
export function focusAdjacentColumn(
  cols: HTMLElement[],
  colIdx: number,
  dir: 1 | -1,
  rowIdx: number,
): void {
  for (let i = colIdx + dir; i >= 0 && i < cols.length; i += dir) {
    const cards = [...cols[i].querySelectorAll<HTMLDivElement>(".agent-card")];
    if (cards.length) {
      focusBoardCard(cards[Math.min(rowIdx, cards.length - 1)]);
      return;
    }
  }
}

boardColumnsEl.addEventListener("keydown", (e) => {
  const card = (e.target as HTMLElement | null)?.closest<HTMLDivElement>(".agent-card");
  // Only when the card itself holds focus — leave inner buttons (Attach/Review/⋯)
  // to their own native key handling.
  if (!card || card !== e.target) return;
  const cols = [...boardColumnsEl.querySelectorAll<HTMLElement>(".board-col")];
  const colIdx = cols.findIndex((c) => c.contains(card));
  const siblings = [
    ...(card.closest(".board-col-body")?.querySelectorAll<HTMLDivElement>(".agent-card") ?? []),
  ];
  const rowIdx = siblings.indexOf(card);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      focusBoardCard(siblings[rowIdx + 1]);
      break;
    case "ArrowUp":
      e.preventDefault();
      focusBoardCard(siblings[rowIdx - 1]);
      break;
    case "ArrowRight":
      e.preventDefault();
      focusAdjacentColumn(cols, colIdx, 1, rowIdx);
      break;
    case "ArrowLeft":
      e.preventDefault();
      focusAdjacentColumn(cols, colIdx, -1, rowIdx);
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      card.click(); // card click === attachCard
      break;
  }
});

/** One section column: header (name + visible count) over a body of stacked
 *  agent cards. Rendered for every section incl. the "no section" catch-all. */
export function renderBoardColumn(sec: BoardSection): HTMLDivElement {
  const col = document.createElement("div");
  col.className = "board-col";
  col.dataset.section = sec.key; // read by the card drag (renderAgentCard) as the drop target

  const header = document.createElement("div");
  header.className = "board-col-header";
  // Drag the header to reorder columns within the strip. The new order commits
  // on release over the strip, so an Esc-cancelled drag leaves it intact.
  draggable(header, () => {
    col.classList.add("dragging");
    return {
      onMove(x, y) {
        if (document.elementFromPoint(x, y)?.closest("#board-columns")) {
          showColDropMarker(colBeforeX(x));
        } else {
          clearColDropMarker();
        }
      },
      onDrop(x, y) {
        if (!document.elementFromPoint(x, y)?.closest("#board-columns")) return;
        const beforeKey = colBeforeX(x)?.dataset.section ?? null;
        const order = orderedSectionColumns()
          .map((s) => s.key)
          .filter((key) => key !== sec.key);
        const idx = beforeKey ? order.indexOf(beforeKey) : order.length;
        order.splice(idx, 0, sec.key);
        boardColOrder = order;
        localStorage.setItem(BOARD_ORDER_KEY, JSON.stringify(order));
        requestRender("board");
      },
      onEnd() {
        col.classList.remove("dragging");
        clearColDropMarker();
      },
    };
  });
  const name = document.createElement("span");
  name.className = "board-col-name";
  name.textContent = sec.name;
  name.title = sec.name;

  const count = document.createElement("span");
  count.className = "board-col-count";
  count.textContent = String(sec.sessions.length);

  header.append(name, count);
  col.appendChild(header);

  const body = document.createElement("div");
  body.className = "board-col-body";
  body.dataset.section = sec.key;
  for (const s of sec.sessions) body.appendChild(renderAgentCard(s));
  col.appendChild(body);
  return col;
}

/** Filter bar: Hide-empty toggle + project filter + name search + primary
 *  "New session". */
