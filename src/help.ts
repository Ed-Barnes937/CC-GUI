// Help overlay listing the GUI's interactions. Toggled with "?" (outside
// inputs) or the Help palette command.

const HELP_SECTIONS: [string, [string, string][]][] = [
  [
    "Sessions",
    [
      ["Click row", "Attach terminal (recreates stopped sessions)"],
      ["Right-click row", "Full menu: shell, review, rename, editor, PR, lifecycle"],
      ["ⓘ / ±", "Details pane / review diff"],
      ["+ on project", "New session (Enter creates, Esc cancels; ↓ picks the harness)"],
      ["$ on project", "Project shell terminal"],
      ["Right-click project", "New session, project shell, remove project"],
    ],
  ],
  [
    "Sidebar",
    [
      ["⋯ menu", "Add project, scan directory, delete merged-PR sessions"],
      ["Path input", "Type to autocomplete directories: ↑/↓ pick, Tab completes, Enter drills in or commits"],
      ["Browse…", "Open the native folder picker"],
      ["GROUP BY", "Segmented control: switch sidebar grouping (Sections / Projects / Status)"],
      ["Drag row → section", "Move a session to a section (drop on In Progress to unpin)"],
      ["● (yellow)", "Unread: agent finished while you were away"],
      ["✎", "Session has pending review comments"],
      ["⇣!", "Auto-pull of project main is blocked (hover for reason)"],
      ["commander chip", "Attach the persistent commander session"],
    ],
  ],
  [
    "Review",
    [
      ["Click / drag lines", "Select for comment (shift-click extends, Esc clears)"],
      ["j / k", "Move the line cursor (Enter or c comments that line)"],
      ["Cmd/Ctrl+Enter", "Save comment"],
      ["↑/↓ or Ctrl-P/N", "Previous / next file"],
      ["○ / ✓", "Toggle file reviewed (bands the row, fills the ring)"],
      ["Apply N comments →", "Send staged comments to the agent (press twice to confirm)"],
      ["↻ / Esc", "Refresh diff / close"],
    ],
  ],
  [
    "File explorer",
    [
      ["Cmd/Ctrl+E", "Open/close the file explorer for the active session's repo"],
      ["↑/↓ or j/k", "Move the cursor"],
      ["Enter / → / l", "Open a folder, or reference the file as @path in the terminal"],
      ["Backspace / ← / h", "Up to the parent folder"],
      ["/", "Filter the current folder (type to narrow, Esc clears)"],
      [".", "Toggle hidden (dot) files"],
      ["Click / double-click", "Move cursor / open"],
      ["Esc", "Close"],
    ],
  ],
  [
    "Board",
    [
      ["Arrow keys", "Move focus between cards and columns"],
      ["Enter / Space", "Attach the focused card"],
      ["Hover / focus a card", "Reveal its attach, review, and ⋯ actions"],
    ],
  ],
  [
    "Global",
    [
      ["Cmd/Ctrl+K", "Fuzzy palette: jump to session or run a command"],
      ["Cmd+W", "Close the active terminal tab (closes the window if none left)"],
      ["Cmd+1–9", "Jump to terminal tab by number"],
      ["Cmd+Opt+←/→", "Previous / next terminal tab"],
      ["Cmd+Opt+↑/↓", "Previous / next session (attaches it)"],
      ["Esc", "Clear the sidebar keyboard cursor"],
      ["?", "This help"],
    ],
  ],
  [
    "Terminal",
    [
      ["Ctrl+\\", "Switch to this session's shell"],
      ["Cmd+←/→", "Cursor to line start / end"],
      ["Cmd+Backspace", "Delete to line start"],
      ["Shift+Enter", "Insert a newline without submitting"],
      ["Select text", "Copies to clipboard and clears the highlight"],
      ["Cmd+Click link", "Open the URL in your browser"],
      ["Drag tab", "Reorder the open terminal tabs"],
      ["Drag tab → corner", "Split the view (up to 4 panes); drag over a quadrant to preview"],
      ["Pane ✕", "Remove a pane from the split (session stays open)"],
      ["Drag pane border", "Resize split panes"],
    ],
  ],
];

const overlay = document.createElement("div");
overlay.id = "help-overlay";
overlay.classList.add("hidden");
const box = document.createElement("div");
box.className = "help-box";
box.setAttribute("role", "dialog");
box.setAttribute("aria-modal", "true");
box.setAttribute("aria-labelledby", "help-title");
// Focusable so opening can move focus into the dialog: this both anchors the
// focus trap and makes the scrollable box reachable by keyboard (arrows / space
// / PageDown scroll the focused container).
box.tabIndex = -1;
const header = document.createElement("div");
header.className = "help-header";
const title = document.createElement("h2");
title.id = "help-title";
title.textContent = "CC-GUI help";
const esc = document.createElement("span");
esc.className = "palette-esc";
esc.textContent = "esc";
header.append(title, esc);
box.appendChild(header);
// Sections flow into a deterministic two-column grid (row-major reading order:
// left-to-right, top-to-bottom).
const columns = document.createElement("div");
columns.className = "help-columns";
box.appendChild(columns);
for (const [section, rows] of HELP_SECTIONS) {
  const block = document.createElement("div");
  block.className = "help-section";
  const h = document.createElement("h3");
  h.textContent = section;
  block.appendChild(h);
  const table = document.createElement("dl");
  table.className = "help-table";
  for (const [key, desc] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = desc;
    table.append(dt, dd);
  }
  block.appendChild(table);
  columns.appendChild(block);
}
// Keybindings section, filled in once the config's key table is fetched
// (main.ts wires the supported actions through setHelpKeybindings).
const keybindBlock = document.createElement("div");
keybindBlock.className = "help-section";
const keybindHeader = document.createElement("h3");
keybindHeader.textContent = "Keyboard (claude-commander config)";
const keybindTable = document.createElement("dl");
keybindTable.className = "help-table";
keybindBlock.style.display = "none";
keybindBlock.append(keybindHeader, keybindTable);
columns.appendChild(keybindBlock);

export function setHelpKeybindings(rows: [string, string][]): void {
  keybindTable.innerHTML = "";
  keybindBlock.style.display = rows.length ? "" : "none";
  for (const [keys, desc] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = keys;
    const dd = document.createElement("dd");
    dd.textContent = desc;
    keybindTable.append(dt, dd);
  }
}

overlay.appendChild(box);
document.body.appendChild(overlay);

// The element focused before the overlay opened, restored on close so keyboard
// users land back where they were.
let lastFocused: HTMLElement | null = null;

function openHelp(): void {
  lastFocused = document.activeElement as HTMLElement | null;
  overlay.classList.remove("hidden");
  box.focus();
}

function closeHelp(): void {
  overlay.classList.add("hidden");
  lastFocused?.focus?.();
  lastFocused = null;
}

export function toggleHelp(): void {
  if (overlay.classList.contains("hidden")) openHelp();
  else closeHelp();
}

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeHelp();
});

// Opening is bound through the config's show_help action (main.ts); these
// only close an open overlay, so they can't double-fire with that binding.
document.addEventListener("keydown", (e) => {
  if (overlay.classList.contains("hidden")) return;
  // Trap Tab: the dialog has no interactive children, so keep focus on the box
  // rather than letting it escape to the obscured page behind the overlay.
  if (e.key === "Tab") {
    e.preventDefault();
    box.focus();
    return;
  }
  const target = e.target as HTMLElement;
  const inInput =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.closest(".xterm") !== null;
  if ((e.key === "?" && !inInput) || e.key === "Escape") closeHelp();
});
