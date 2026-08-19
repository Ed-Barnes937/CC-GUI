// Pointer-driven drag-and-drop.
//
// HTML5 native drag-and-drop is unavailable: Tauri's OS drag-drop handler
// (enabled for file drops in tauri.conf.json) swallows the webview's HTML5
// drag events. So tab reorder, sidebar row -> section, board card -> column,
// and board column reorder are all driven by pointer events instead, and all
// four share the gesture below.
//
// A drag begins only once the pointer moves past a small threshold, so plain
// clicks and context-menus on the handle still work. During a drag the handle
// captures the pointer and each flow hit-tests its own drop targets (by
// elementFromPoint or coordinates) in `onMove`/`onDrop`. `onDrop` runs only on
// release over a target; Esc or pointercancel ends the drag with `onEnd` alone,
// leaving state untouched — mirroring the old `drop`-vs-`dragend` split.
export interface DragSession {
  onMove(x: number, y: number): void;
  onDrop(x: number, y: number): void;
  onEnd(): void;
}

export function draggable(handle: HTMLElement, begin: () => DragSession | null): void {
  handle.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return; // left button only; right-click = context menu
    const sx = down.clientX;
    const sy = down.clientY;
    let sess: DragSession | null = null;

    const move = (e: PointerEvent) => {
      if (!sess) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return; // below threshold: still a click
        sess = begin();
        if (!sess) return teardown();
        handle.setPointerCapture(down.pointerId);
        document.body.style.userSelect = "none";
      }
      e.preventDefault(); // suppress text selection / scroll while dragging
      sess.onMove(e.clientX, e.clientY);
    };
    const end = (drop: PointerEvent | null) => {
      if (sess) {
        if (drop) sess.onDrop(drop.clientX, drop.clientY);
        sess.onEnd();
        document.body.style.userSelect = "";
        if (drop) suppressNextClick(handle); // eat the click synthesized by this pointerup
      }
      teardown();
    };
    const onUp = (e: PointerEvent) => end(e);
    const onCancel = () => end(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sess) {
        e.preventDefault();
        e.stopPropagation();
        end(null);
      }
    };
    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      try {
        handle.releasePointerCapture(down.pointerId);
      } catch {
        // never captured (drag never crossed the threshold) — nothing to release
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  });
}

/** Swallow the click synthesized by a drag-ending pointerup, so a drag that
 *  starts on a clickable handle (tab, card, row) doesn't also fire its click. */
function suppressNextClick(handle: HTMLElement): void {
  const eat = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    handle.removeEventListener("click", eat, true);
  };
  handle.addEventListener("click", eat, true);
  // If no click follows (release off the handle), drop the listener next tick so
  // it can't eat an unrelated later click.
  setTimeout(() => handle.removeEventListener("click", eat, true), 0);
}

