// The two GUI-only tabs: Features and Appearance.
//
// Both write straight through to localStorage (the feature registry, the theme
// prefs) rather than the config draft, so their rows sit outside the pane's
// Save/Cancel flow -- their notes in the schema say so.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { allFeatures, isEnabled, setEnabled } from "../features";
import { getMode, setMode, type Mode } from "../theme";
import { openThemeModal } from "../theme/modal";
import { fieldId } from "./state";
import { closeSettings } from "./shell";

/** One switch per registered optional feature. Writes straight through to the
 *  registry (localStorage) rather than the config draft, so these rows are
 *  outside the Save/Cancel flow — same as the appearance controls. */
export function renderFeatures(panel: HTMLElement): void {
  const features = allFeatures();
  if (features.length === 0) {
    const empty = document.createElement("p");
    empty.className = "settings-note";
    empty.textContent = "No optional features are available in this build.";
    panel.appendChild(empty);
    return;
  }

  for (const f of features) {
    const row = document.createElement("div");
    row.className = "settings-field";
    const head = document.createElement("div");
    head.className = "settings-field-head";
    const label = document.createElement("label");
    label.className = "settings-field-label";
    label.htmlFor = fieldId(`feature.${f.id}`);
    label.textContent = f.name;
    const desc = document.createElement("div");
    desc.className = "settings-field-desc";
    desc.textContent = f.desc;
    head.append(label, desc);

    const wrap = document.createElement("label");
    wrap.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = fieldId(`feature.${f.id}`);
    input.checked = isEnabled(f.id);
    input.addEventListener("change", () => setEnabled(f.id, input.checked));
    const slider = document.createElement("span");
    slider.className = "slider";
    wrap.append(input, slider);

    row.append(head, wrap);
    panel.appendChild(row);
  }
}

export function renderTheme(panel: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "settings-field";
  const head = document.createElement("div");
  head.className = "settings-field-head";
  const label = document.createElement("label");
  label.className = "settings-field-label";
  label.textContent = "Appearance";
  head.appendChild(label);
  const desc = document.createElement("div");
  desc.className = "settings-field-desc";
  desc.textContent = "Follow the OS, or force light/dark.";
  head.appendChild(desc);

  const seg = document.createElement("div");
  seg.className = "settings-segment";
  const modes: { v: Mode; l: string }[] = [
    { v: "system", l: "System" },
    { v: "light", l: "Light" },
    { v: "dark", l: "Dark" },
  ];
  for (const { v, l } of modes) {
    const b = document.createElement("button");
    b.textContent = l;
    b.dataset.mode = v;
    b.classList.toggle("active", getMode() === v);
    b.addEventListener("click", () => {
      setMode(v);
      for (const sib of seg.querySelectorAll("button")) {
        sib.classList.toggle("active", sib === b);
      }
    });
    seg.appendChild(b);
  }
  row.append(head, seg);
  panel.appendChild(row);

  const themesRow = document.createElement("div");
  themesRow.className = "settings-field";
  const th = document.createElement("div");
  th.className = "settings-field-head";
  const tl = document.createElement("label");
  tl.className = "settings-field-label";
  tl.textContent = "Themes";
  th.appendChild(tl);
  const td = document.createElement("div");
  td.className = "settings-field-desc";
  td.textContent = "Pick the theme used for each appearance, with live preview.";
  th.appendChild(td);

  const actions = document.createElement("div");
  actions.className = "settings-theme-actions";
  const dark = document.createElement("button");
  dark.className = "row-action";
  dark.textContent = "Dark theme…";
  dark.addEventListener("click", () => {
    closeSettings();
    openThemeModal("dark");
  });
  const light = document.createElement("button");
  light.className = "row-action";
  light.textContent = "Light theme…";
  light.addEventListener("click", () => {
    closeSettings();
    openThemeModal("light");
  });
  const folder = document.createElement("button");
  folder.className = "row-action";
  folder.textContent = "Open themes folder…";
  folder.addEventListener("click", () => void invoke("open_themes_dir").catch((e) => toast(`${e}`, "error")));
  actions.append(dark, light, folder);
  themesRow.append(th, actions);
  panel.appendChild(themesRow);
}
