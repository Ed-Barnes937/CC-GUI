// Minimal custom context menu: one floating menu at a time, dismissed by any
// click, Esc, or scroll.

export type MenuItem =
  | {
      label: string;
      action: () => void;
      danger?: boolean;
      warning?: boolean;
      /** Formatted shortcut glyphs (e.g. "⌃D"), shown right-aligned. */
      shortcut?: string;
      /** Consequence text shown dim and inline after the label (e.g. "keeps the worktree"). */
      sublabel?: string;
      /** For a menu that ticks one entry: true draws the ✓, false keeps the
       *  tick column empty so the names line up. */
      checked?: boolean;
      /** Dim text after the label, without the sublabel's " · " (e.g. "3 projects"). */
      meta?: string;
      /** Indent a plain row to line up with a ticking menu's names. */
      indent?: boolean;
    }
  | { header: string }
  | "separator";

/** How a menu opens beyond its items. */
export type MenuOptions = {
  /** Extra class on the menu element, for a menu with its own sizing. */
  className?: string;
  /** Called once when the menu goes away, however it was dismissed. */
  onClose?: () => void;
};

let menuEl: HTMLDivElement | null = null;
let closeHook: (() => void) | null = null;

export function dismissMenu(): void {
  menuEl?.remove();
  menuEl = null;
  const hook = closeHook;
  closeHook = null;
  hook?.();
}

/** Whether a menu is open. */
export function menuOpen(): boolean {
  return menuEl !== null;
}

export function showContextMenu(e: MouseEvent, items: MenuItem[], options: MenuOptions = {}): void {
  e.preventDefault();
  e.stopPropagation();
  openMenu(e.clientX, e.clientY, items, options);
}

/** Open a menu anchored below an element (6px under it, left edges aligned),
 *  as a title-bar dropdown does, rather than at the pointer. */
export function showMenuBelow(anchor: Element, items: MenuItem[], options: MenuOptions = {}): void {
  const r = anchor.getBoundingClientRect();
  openMenu(r.left, r.bottom + 6, items, options);
}

function openMenu(x: number, y: number, items: MenuItem[], options: MenuOptions): void {
  dismissMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  if (options.className) menu.classList.add(options.className);
  for (const item of items) {
    if (item === "separator") {
      const sep = document.createElement("div");
      sep.className = "menu-separator";
      menu.appendChild(sep);
      continue;
    }
    if ("header" in item) {
      const head = document.createElement("div");
      head.className = "menu-header";
      head.textContent = item.header;
      menu.appendChild(head);
      continue;
    }
    const row = document.createElement("div");
    row.className = "menu-item";
    row.setAttribute("role", "menuitem");
    if (item.danger) row.classList.add("danger");
    if (item.warning) row.classList.add("warning");
    if (item.indent) row.classList.add("indent");
    if (item.checked !== undefined) {
      row.classList.add("checkable");
      row.setAttribute("aria-checked", item.checked ? "true" : "false");
      const tick = document.createElement("span");
      tick.className = "menu-tick";
      tick.textContent = item.checked ? "✓" : "";
      row.appendChild(tick);
    }
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    if (item.sublabel) {
      const sub = document.createElement("span");
      sub.className = "menu-sublabel";
      sub.textContent = ` · ${item.sublabel}`;
      label.appendChild(sub);
    }
    row.appendChild(label);
    if (item.meta) {
      const meta = document.createElement("span");
      meta.className = "menu-meta";
      meta.textContent = item.meta;
      row.appendChild(meta);
    }
    if (item.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "menu-shortcut";
      kbd.textContent = item.shortcut;
      row.appendChild(kbd);
    }
    row.addEventListener("click", () => {
      dismissMenu();
      item.action();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  menuEl = menu;
  closeHook = options.onClose ?? null;

  // Position, clamped to the viewport.
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - rect.height - 4)}px`;
}

document.addEventListener("click", dismissMenu);
document.addEventListener("contextmenu", (e) => {
  // Right-clicking outside a menu trigger dismisses any open menu.
  if (menuEl && !menuEl.contains(e.target as Node)) dismissMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dismissMenu();
});
window.addEventListener("blur", dismissMenu);
