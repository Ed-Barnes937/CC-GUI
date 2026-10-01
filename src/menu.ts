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
      /** Shown dimmed and not clickable (the current choice, say). */
      disabled?: boolean;
      /** A short dim tag at the row's right edge (e.g. "current"). */
      tag?: string;
    }
  | {
      label: string;
      /** A row that opens a submenu beside it (drawn with a trailing ▸). Built
       *  when it opens, so its items reflect the moment. */
      submenu: () => MenuItem[];
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
let subEl: HTMLDivElement | null = null;
let subOwner: HTMLElement | null = null;
let subCloseTimer: number | undefined;
let closeHook: (() => void) | null = null;

export function dismissMenu(): void {
  closeSubmenu();
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
  const menu = buildMenu(items);
  if (options.className) menu.classList.add(options.className);
  document.body.appendChild(menu);
  menuEl = menu;
  closeHook = options.onClose ?? null;

  // Position, clamped to the viewport.
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - rect.height - 4)}px`;
}

function buildMenu(items: MenuItem[]): HTMLDivElement {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
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
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;

    if ("submenu" in item) {
      row.classList.add("has-submenu");
      row.setAttribute("aria-haspopup", "menu");
      const arrow = document.createElement("span");
      arrow.className = "menu-shortcut";
      arrow.textContent = "▸";
      row.append(label, arrow);
      const open = () => {
        clearTimeout(subCloseTimer);
        if (subOwner !== row) openSubmenu(row, item.submenu());
      };
      row.addEventListener("mouseenter", open);
      row.addEventListener("click", (e) => {
        e.stopPropagation(); // not a pick: keep the menu open
        open();
      });
      menu.appendChild(row);
      continue;
    }

    // Any other row of the menu that holds the submenu closes it -- after a
    // beat, so a pointer cutting diagonally across a row on its way into the
    // submenu doesn't lose it.
    row.addEventListener("mouseenter", () => {
      if (!subEl || subOwner?.parentElement !== menu) return;
      clearTimeout(subCloseTimer);
      subCloseTimer = window.setTimeout(closeSubmenu, 250);
    });

    if (item.danger) row.classList.add("danger");
    if (item.warning) row.classList.add("warning");
    if (item.indent) row.classList.add("indent");
    if (item.disabled) {
      row.classList.add("disabled");
      row.setAttribute("aria-disabled", "true");
    }
    if (item.checked !== undefined) {
      row.classList.add("checkable");
      row.setAttribute("aria-checked", item.checked ? "true" : "false");
      const tick = document.createElement("span");
      tick.className = "menu-tick";
      tick.textContent = item.checked ? "✓" : "";
      row.appendChild(tick);
    }
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
    if (item.tag) {
      const tag = document.createElement("span");
      tag.className = "menu-tag";
      tag.textContent = item.tag;
      row.appendChild(tag);
    }
    if (item.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "menu-shortcut";
      kbd.textContent = item.shortcut;
      row.appendChild(kbd);
    }
    row.addEventListener("click", (e) => {
      if (item.disabled) {
        e.stopPropagation(); // inert: neither a pick nor a dismissal
        return;
      }
      dismissMenu();
      item.action();
    });
    menu.appendChild(row);
  }
  return menu;
}

/** Open `items` beside `row`: to its right, top-aligned with it, or to the
 *  left when there's no room on the right. */
function openSubmenu(row: HTMLElement, items: MenuItem[]): void {
  closeSubmenu();
  const sub = buildMenu(items);
  sub.classList.add("submenu");
  // Hovering into the submenu keeps it, however the pointer got there.
  sub.addEventListener("mouseenter", () => clearTimeout(subCloseTimer));
  document.body.appendChild(sub);
  subEl = sub;
  subOwner = row;
  row.classList.add("open");

  const parent = row.parentElement!.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const rect = sub.getBoundingClientRect();
  const { innerWidth, innerHeight } = window;
  // The submenu's first row lines up with this one (its 4px padding + 1px border).
  const right = parent.right + 2;
  const left = right + rect.width <= innerWidth - 4 ? right : Math.max(4, parent.left - rect.width - 2);
  sub.style.left = `${left}px`;
  sub.style.top = `${Math.max(4, Math.min(r.top - 5, innerHeight - rect.height - 4))}px`;
}

function closeSubmenu(): void {
  clearTimeout(subCloseTimer);
  subEl?.remove();
  subEl = null;
  subOwner?.classList.remove("open");
  subOwner = null;
}

document.addEventListener("click", dismissMenu);
document.addEventListener("contextmenu", (e) => {
  // Right-clicking outside a menu trigger dismisses any open menu.
  const target = e.target as Node;
  if (menuEl && !menuEl.contains(target) && !subEl?.contains(target)) dismissMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dismissMenu();
});
window.addEventListener("blur", dismissMenu);
