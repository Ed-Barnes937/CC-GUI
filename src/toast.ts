// In-app toasts and confirm dialog. wry's WKWebView on macOS implements
// neither window.alert (silent no-op) nor window.confirm (always false), so
// native JS dialogs must never be used — route everything through here.

import { noTextAssist } from "./dom";

let stack: HTMLDivElement | null = null;

function toastStack(): HTMLDivElement {
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

/** Show a transient toast. Errors stay longer and are styled red. `detail`
 *  (e.g. a raw backend error) is tucked into the hover title so the visible
 *  message can stay a plain-language sentence. */
export function toast(
  message: string,
  kind: "info" | "error" = "info",
  detail?: string,
): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  if (detail) el.title = detail;
  el.addEventListener("click", () => el.remove());
  toastStack().appendChild(el);
  setTimeout(() => {
    el.classList.add("fade");
    setTimeout(() => el.remove(), 300);
  }, kind === "error" ? 8000 : 4000);
}

/**
 * In-app replacement for window.confirm. Resolves true on Confirm/Enter,
 * false on Cancel/Esc/backdrop click.
 */
export function confirmDialog(message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const box = document.createElement("div");
    box.className = "confirm-box";
    const text = document.createElement("div");
    text.className = "confirm-text";
    text.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "danger";
    ok.textContent = confirmLabel;
    buttons.append(cancel, ok);
    box.append(text, buttons);
    overlay.appendChild(box);

    const done = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(false);
      // Don't override a focused Cancel button: Enter there means cancel.
      if (e.key === "Enter" && document.activeElement !== cancel) done(true);
    });

    document.body.appendChild(overlay);
    ok.focus();
  });
}

/** One consequence line for the delete checklist: a toned glyph + text, with
 *  an optional trailing mono fragment (the branch name). */
function consequenceRow(glyph: string, tone: "cut" | "keep", text: string, mono?: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "delete-check";
  const mark = document.createElement("span");
  mark.className = `check-${tone}`;
  mark.textContent = glyph;
  const label = document.createElement("span");
  label.textContent = text;
  if (mono !== undefined) {
    const m = document.createElement("span");
    m.className = "check-mono";
    m.textContent = mono;
    label.append(" ", m);
  }
  row.append(mark, label);
  return row;
}

/**
 * Dedicated delete-session confirmation: a danger-tinted ⌦ badge beside the
 * title + mono session name, then the consequences as a checklist — one line
 * per effect instead of prose. The branch line is deliberately a ✓ "kept":
 * the backend never deletes the branch. Resolves true on Delete/Enter, false
 * on Cancel/Esc/backdrop click. Lifecycle mirrors confirmDialog.
 */
export function deleteSessionDialog(name: string, branch: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const box = document.createElement("div");
    box.className = "confirm-box delete-dialog";

    const head = document.createElement("div");
    head.className = "delete-head";
    const icon = document.createElement("div");
    icon.className = "delete-icon";
    icon.textContent = "⌦";
    const titles = document.createElement("div");
    titles.className = "delete-titles";
    const heading = document.createElement("div");
    heading.className = "delete-heading";
    heading.textContent = "Delete session";
    const nameEl = document.createElement("div");
    nameEl.className = "delete-name";
    nameEl.textContent = name;
    titles.append(heading, nameEl);
    head.append(icon, titles);

    const intro = document.createElement("div");
    intro.className = "delete-intro";
    intro.textContent = "Deleting this session:";

    const list = document.createElement("div");
    list.className = "delete-list";
    list.append(
      consequenceRow("✕", "cut", "Kills the running agent"),
      consequenceRow("✕", "cut", "Removes the worktree + tmux session"),
      consequenceRow("✓", "keep", "Keeps the branch", branch),
    );

    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "danger";
    ok.textContent = "Delete session";
    buttons.append(cancel, ok);

    box.append(head, intro, list, buttons);
    overlay.appendChild(box);

    const done = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(false);
      // Don't override a focused Cancel button: Enter there means cancel.
      if (e.key === "Enter" && document.activeElement !== cancel) done(true);
    });

    document.body.appendChild(overlay);
    ok.focus();
  });
}

/**
 * In-app replacement for window.prompt. Resolves the trimmed input on Save/Enter,
 * or null on Cancel/Esc/backdrop click or empty input.
 *
 * With `validate`, a submit first runs it on the raw input: a returned message
 * is shown under the field and the dialog stays open (an empty input is then
 * the validator's to judge too); null lets the submit through.
 */
export function promptDialog(
  message: string,
  placeholder = "",
  confirmLabel = "Save",
  validate?: (value: string) => string | null,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const box = document.createElement("div");
    box.className = "confirm-box";
    const text = document.createElement("div");
    text.className = "confirm-text";
    text.textContent = message;
    const input = noTextAssist(document.createElement("input"));
    input.className = "rename-input";
    input.placeholder = placeholder;
    const error = document.createElement("div");
    error.className = "confirm-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.textContent = confirmLabel;
    buttons.append(cancel, ok);
    box.append(text, input, error, buttons);
    overlay.appendChild(box);

    const done = (result: string | null) => {
      overlay.remove();
      resolve(result);
    };
    const submit = () => {
      const problem = validate?.(input.value) ?? null;
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.focus();
        return;
      }
      done(input.value.trim() || null);
    };
    // A stale complaint goes as soon as the user edits.
    input.addEventListener("input", () => {
      error.hidden = true;
    });
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", submit);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(null);
    });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(null);
      if (e.key === "Enter") submit();
    });

    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  });
}
