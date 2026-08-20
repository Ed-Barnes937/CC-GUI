// Image files render as a before/after comparison instead of text hunks: one
// image for an add or a delete, a juxtapose wipe for a modification.

import { invoke } from "@tauri-apps/api/core";
import { displayPath, type FileDiff } from "./model";
import { diffEl, selectedFile, sessionId } from "./state";

/** Image data-URL cache, keyed by `${path}\0${side}`. Reset on refresh so a new
 *  snapshot re-reads the bytes; avoids re-fetching on theme change / re-render. */
const imageCache = new Map<string, string>();

export function resetImageCache(): void {
  imageCache.clear();
}

/** Fetch one side of an image as a data URL, memoized for this snapshot. */
async function loadImage(
  id: string,
  path: string,
  side: "old" | "new",
  mime: string,
): Promise<string> {
  const key = `${path}\x00${side}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const b64 = await invoke<string>("read_review_image", { id, path, side });
  const url = `data:${mime};base64,${b64}`;
  imageCache.set(key, url);
  return url;
}

/**
 * Render an image file as a before/after comparison instead of text hunks.
 * Added files show only the working image, deleted only the base, and modified
 * files a juxtapose slider. Async because it reads the bytes from the backend;
 * guards against the file/session changing while loading.
 */
export async function renderImageDiff(file: FileDiff, mime: string): Promise<void> {
  const id = sessionId();
  const path = displayPath(file);
  if (!id) return;

  const needOld = file.status !== "added";
  const needNew = file.status !== "deleted";
  // A rename moves the blob, so each side lives at its own path; for every
  // other status old_path === new_path.
  const oldPath = file.old_path;
  const newPath = file.new_path;
  const someUncached =
    (needOld && !imageCache.has(`${oldPath}\x00old`)) ||
    (needNew && !imageCache.has(`${newPath}\x00new`));
  if (someUncached) diffEl.innerHTML = '<div class="review-empty">Loading image…</div>';

  let oldUrl: string | null = null;
  let newUrl: string | null = null;
  try {
    if (needOld) oldUrl = await loadImage(id, oldPath, "old", mime);
    if (needNew) newUrl = await loadImage(id, newPath, "new", mime);
  } catch (e) {
    if (sessionId() !== id || selectedFile() !== path) return;
    diffEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "review-empty error";
    err.textContent = "Couldn't load this image.";
    err.title = String(e); // raw backend error on hover, not in the face
    diffEl.appendChild(err);
    return;
  }
  if (sessionId() !== id || selectedFile() !== path) return; // switched away while loading

  diffEl.innerHTML = "";
  const pane = document.createElement("div");
  pane.className = "review-image-pane";
  if (oldUrl && newUrl) pane.appendChild(buildJuxtapose(oldUrl, newUrl));
  else if (newUrl) pane.appendChild(buildSingleImage(newUrl, "added (working)"));
  else if (oldUrl) pane.appendChild(buildSingleImage(oldUrl, "deleted (base)"));
  diffEl.appendChild(pane);
}

function buildSingleImage(url: string, label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "review-image single";
  const img = document.createElement("img");
  img.src = url;
  img.alt = label;
  const cap = document.createElement("span");
  cap.className = "ji-label";
  cap.textContent = label;
  wrap.append(img, cap);
  return wrap;
}

/** A juxtapose slider: working image underneath, base clipped on top, with a
 *  draggable (and arrow-key-able) divider wiping between them. */
function buildJuxtapose(oldUrl: string, newUrl: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "review-image juxtapose";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "slider");
  wrap.setAttribute("aria-label", "Image comparison — drag or use arrow keys to wipe");
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "100");

  const baseImg = document.createElement("img"); // bottom layer = working (new)
  baseImg.className = "ji-base";
  baseImg.src = newUrl;
  baseImg.alt = "working";

  const overlay = document.createElement("img"); // top layer = base (old), clipped
  overlay.className = "ji-overlay";
  overlay.src = oldUrl;
  overlay.alt = "base";

  const divider = document.createElement("div");
  divider.className = "ji-divider";
  const handle = document.createElement("div");
  handle.className = "ji-handle";
  divider.appendChild(handle);

  const labelOld = document.createElement("span");
  labelOld.className = "ji-label ji-label-old";
  labelOld.textContent = "base";
  const labelNew = document.createElement("span");
  labelNew.className = "ji-label ji-label-new";
  labelNew.textContent = "working";

  wrap.append(baseImg, overlay, divider, labelOld, labelNew);

  let pos = 50;
  const apply = (): void => {
    overlay.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    divider.style.left = `${pos}%`;
    wrap.setAttribute("aria-valuenow", String(Math.round(pos)));
  };
  apply();

  const setFromX = (clientX: number): void => {
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0) return;
    pos = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    apply();
  };

  let dragging = false;
  wrap.addEventListener("pointerdown", (e) => {
    dragging = true;
    wrap.setPointerCapture(e.pointerId);
    setFromX(e.clientX);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (dragging) setFromX(e.clientX);
  });
  const stop = (e: PointerEvent): void => {
    dragging = false;
    if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
  };
  wrap.addEventListener("pointerup", stop);
  wrap.addEventListener("pointercancel", stop);
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") pos = Math.max(0, pos - 2);
    else if (e.key === "ArrowRight") pos = Math.min(100, pos + 2);
    else return;
    e.preventDefault();
    apply();
  });

  return wrap;
}
