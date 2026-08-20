// The modal shell: the overlay and the dialog box everything else renders into.
//
// Its own module so the panels can close the pane (the Appearance tab does,
// before handing over to the theme picker) without importing the renderer.

const overlay = document.createElement("div");
overlay.id = "settings-overlay";
overlay.classList.add("hidden");
const box = document.createElement("div");
box.className = "settings-box";
box.setAttribute("role", "dialog");
box.setAttribute("aria-modal", "true");
box.setAttribute("aria-label", "Settings");
overlay.appendChild(box);
document.body.appendChild(overlay);


export { overlay, box };

export function openOverlay(): void {
  overlay.classList.remove("hidden");
}

export function closeSettings(): void {
  overlay.classList.add("hidden");
}

export function isOpen(): boolean {
  return !overlay.classList.contains("hidden");
}
