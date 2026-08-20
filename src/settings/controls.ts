// One schema field -> one live control, wired straight into the config draft.
//
// Every control writes through to `working` on input; numbers normalize on blur
// so a stored value never silently diverges from what the field shows.

import { noTextAssist } from "../dom";
import { CATEGORIES, type Field } from "./schema";
import { activeCat, fieldId, getPath, redrawPanel, setPath, working } from "./state";

/** Build the control element for a schema field, wiring change → `working`. */
export function makeControl(field: Field): HTMLElement {
  const { path, control } = field;
  const value = getPath(working, path);
  let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

  switch (control.kind) {
    case "toggle": {
      const wrap = document.createElement("label");
      wrap.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = fieldId(path);
      input.checked = value === true;
      input.dataset.key = path;
      input.dataset.kind = "toggle";
      input.addEventListener("change", () => {
        setPath(working, path, input.checked);
        // Master toggles gate other fields — re-render so they enable/disable.
        if (categoryGatesOn(path)) redrawPanel();
      });
      const slider = document.createElement("span");
      slider.className = "slider";
      wrap.append(input, slider);
      return wrap;
    }
    case "number":
    case "number-nullable": {
      const input = document.createElement("input");
      input.type = "number";
      if (control.min !== undefined) input.min = String(control.min);
      if (control.max !== undefined) input.max = String(control.max);
      if ("step" in control && control.step !== undefined) input.step = String(control.step);
      input.value = value == null ? "" : String(value);
      input.dataset.key = path;
      input.dataset.kind = control.kind;
      input.addEventListener("input", () => {
        const raw = input.value.trim();
        if (raw === "") {
          if (control.kind === "number-nullable") setPath(working, path, null);
          return; // required numbers keep their last value until blur normalizes
        }
        const n = Number(raw);
        if (!Number.isNaN(n)) setPath(working, path, n);
      });
      // Normalize on blur so a stored value never silently diverges from the
      // field: clamp out-of-range numbers to the min/max, and snap a blanked or
      // unparseable required field back to the value actually stored.
      input.addEventListener("blur", () => {
        const raw = input.value.trim();
        const stored = getPath(working, path);
        if (raw === "" || Number.isNaN(Number(raw))) {
          if (raw === "" && control.kind === "number-nullable") {
            setPath(working, path, null);
            input.value = "";
          } else {
            input.value = stored == null ? "" : String(stored);
          }
          return;
        }
        let n = Number(raw);
        if (control.min !== undefined && n < control.min) n = control.min;
        if (control.max !== undefined && n > control.max) n = control.max;
        input.value = String(n);
        setPath(working, path, n);
      });
      el = input;
      break;
    }
    case "select": {
      const select = document.createElement("select");
      for (const opt of control.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.value = value == null ? "" : String(value);
      select.dataset.key = path;
      select.dataset.kind = "select";
      select.addEventListener("change", () => setPath(working, path, select.value));
      el = select;
      break;
    }
    case "tristate-null": {
      const select = document.createElement("select");
      const opts: { v: string; l: string }[] = [
        { v: "auto", l: control.auto },
        { v: "on", l: control.on },
        { v: "off", l: control.off },
      ];
      for (const { v, l } of opts) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        select.appendChild(o);
      }
      select.value = value === true ? "on" : value === false ? "off" : "auto";
      select.dataset.key = path;
      select.dataset.kind = "select";
      select.addEventListener("change", () => {
        setPath(working, path, select.value === "on" ? true : select.value === "off" ? false : null);
      });
      el = select;
      break;
    }
    case "string-list": {
      const area = noTextAssist(document.createElement("textarea"));
      area.value = Array.isArray(value) ? (value as unknown[]).map(String).join("\n") : "";
      area.rows = Math.min(6, Math.max(2, (Array.isArray(value) ? value.length : 0) + 1));
      area.placeholder = control.placeholder ?? "";
      area.dataset.key = path;
      area.dataset.kind = "string-list";
      area.addEventListener("input", () => {
        const list = area.value.split("\n").map((s) => s.trim()).filter(Boolean);
        setPath(working, path, list);
      });
      el = area;
      break;
    }
    default: {
      // text | path | nullable
      const input = noTextAssist(document.createElement("input"));
      input.type = "text";
      input.value = value == null ? "" : String(value);
      input.placeholder = control.placeholder ?? "";
      input.dataset.key = path;
      input.dataset.kind = control.kind;
      input.addEventListener("input", () => {
        const v = input.value;
        if (control.kind === "text") setPath(working, path, v);
        else setPath(working, path, v.trim() === "" ? null : v);
      });
      el = input;
    }
  }

  el.id = fieldId(path);
  if (field.enabledBy && getPath(working, field.enabledBy) !== true) {
    el.disabled = true;
  }
  return el;
}

/** Whether toggling `path` should re-render (because some field is gated by it). */
function categoryGatesOn(path: string): boolean {
  const cat = CATEGORIES.find((c) => c.id === activeCat());
  if (!cat || !("fields" in cat)) return false;
  return cat.fields.some((f) => f.enabledBy === path);
}
