// Drawing the Board.
//
// Same snapshot as the sidebar, arranged as columns of cards instead of a
// list. The filter bar is rebuilt first because the title bar's attention pill
// is mirrored into it.

import { registerView } from "../app/render";
import { boardColumnsEl, boardFilterEl } from "../app/elements";
import { onSelectionChange, selectedSession } from "../session/selection";
import { boardCardRefs, hideEmptyColumns } from "./state";
import { renderBoardFilterBar } from "./filterBar";
import { orderedSectionColumns, renderBoardColumn, updateBoardRoving } from "./columns";

export function renderBoardColumns(): void {
  // Columns are rebuilt wholesale on every snapshot tick (~2s); capture the
  // per-column vertical scroll (keyed by section) + the strip's horizontal
  // scroll so an in-progress session doesn't yank the view back to the top.
  const prevScroll = new Map<string, number>();
  for (const body of boardColumnsEl.querySelectorAll<HTMLElement>(".board-col-body")) {
    if (body.dataset.section) prevScroll.set(body.dataset.section, body.scrollTop);
  }
  const prevScrollLeft = boardColumnsEl.scrollLeft;

  boardCardRefs.clear();
  boardColumnsEl.innerHTML = "";
  for (const sec of orderedSectionColumns()) {
    // "Hide empty" hides columns with no VISIBLE cards, so a section whose
    // sessions are all filtered out drops too.
    if (hideEmptyColumns() && sec.sessions.length === 0) continue;
    boardColumnsEl.appendChild(renderBoardColumn(sec));
  }

  for (const body of boardColumnsEl.querySelectorAll<HTMLElement>(".board-col-body")) {
    const top = body.dataset.section ? prevScroll.get(body.dataset.section) : undefined;
    if (top) body.scrollTop = top;
  }
  boardColumnsEl.scrollLeft = prevScrollLeft;
  updateBoardRoving();
}

/** Full board render. The filter bar is rebuilt only when needed (it owns the
 *  live search input); columns rebuild on every snapshot tick. Preserving the
 *  search field's focus/value: the input keeps its own value, and a snapshot
 *  re-render only touches columns, never the filter bar. */
export function renderBoard(): void {
  if (!boardFilterEl.childElementCount) renderBoardFilterBar();
  renderBoardColumns();
}

registerView("board", renderBoard);

// Board cards draw the same cursor the sidebar rows do.
onSelectionChange(() => {
  const id = selectedSession();
  for (const [cardId, card] of boardCardRefs) card.classList.toggle("selected", cardId === id);
});
