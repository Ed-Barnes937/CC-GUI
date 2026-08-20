// Comment cards and the composer: a saved comment, the editor that creates one,
// and the trailing section for comments whose line has left the diff.

import { invoke } from "@tauri-apps/api/core";
import { noTextAssist } from "../dom";
import { toast } from "../toast";
import { buildDraft, displayPath, type Comment, type DiffLine } from "./model";
import {
  clearSelection,
  currentFile,
  draftText,
  redraw,
  refreshReview,
  sessionId,
  setDraftText,
} from "./state";

/** The "y" avatar + "you" + status tag row shared by a saved comment card and
 *  the open composer (which reads "staged" ahead of the save that makes it so). */
export function commentHead(status: Comment["status"]): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "comment-head";
  const avatar = document.createElement("span");
  avatar.className = "comment-avatar";
  avatar.textContent = "y";
  const who = document.createElement("span");
  who.className = "comment-who";
  who.textContent = "you";
  const tag = document.createElement("span");
  tag.className = `comment-tag comment-${status}`;
  tag.textContent = status;
  head.append(avatar, who, tag);
  return head;
}

export function renderCommentBlock(c: Comment): HTMLDivElement {
  const block = document.createElement("div");
  block.className = `review-comment comment-${c.status}`;
  const head = commentHead(c.status);
  const range = document.createElement("span");
  range.className = "comment-range";
  const [start, end] = c.line_range;
  range.textContent = `${c.side} ${start === end ? start : `${start}–${end}`}`;
  head.appendChild(range);
  if (c.status !== "applied") {
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const del = document.createElement("button");
    del.className = "comment-delete";
    del.textContent = "✕";
    del.title = "Delete comment";
    del.addEventListener("click", () => void deleteComment(c.id));
    head.append(spacer, del);
  }
  const body = document.createElement("div");
  body.className = "comment-body";
  body.textContent = c.comment;
  block.append(head, body);
  return block;
}

async function deleteComment(commentId: string): Promise<void> {
  if (!sessionId()) return;
  try {
    await invoke("delete_comment", { id: sessionId(), commentId });
  } catch (e) {
    toast("Couldn't delete the comment.", "error", String(e));
    return;
  }
  await refreshReview();
}

/**
 * Build the comment draft from the selected lines, mirroring the TUI's
 * `build_draft`: the New side wins unless the selection is purely deletions,
 * and the snippet/line range come from that side's lines only.
 */
async function saveComment(lines: DiffLine[], comment: string): Promise<void> {
  const file = currentFile();
  if (!sessionId() || !file || !comment.trim()) return;
  const draft = buildDraft(lines);
  if (!draft) return;
  try {
    await invoke("create_comment", {
      id: sessionId(),
      file: displayPath(file),
      side: draft.side,
      lineRange: draft.lineRange,
      snippet: draft.snippet,
      comment: comment.trim(),
    });
  } catch (e) {
    toast("Couldn't save the comment.", "error", String(e));
    return;
  }
  clearSelection();
  await refreshReview();
}

export function renderCommentEditor(lines: DiffLine[]): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "review-comment editor comment-staged";
  const draft = buildDraft(lines);
  const head = commentHead("staged");
  const tag = head.querySelector<HTMLSpanElement>(".comment-tag")!;
  if (draft) {
    const [start, end] = draft.lineRange;
    tag.textContent = `staged · ${start === end ? `line ${end}` : `lines ${start}–${end}`}`;
  }
  box.appendChild(head);

  const textarea = noTextAssist(document.createElement("textarea"));
  textarea.placeholder = "Leave a comment for the agent… (Cmd/Ctrl+Enter to save, Esc to cancel)";
  textarea.rows = 3;
  textarea.value = draftText();
  textarea.addEventListener("input", () => {
    setDraftText(textarea.value);
  });
  textarea.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep Esc from closing the whole review view
    if (e.key === "Escape") {
      clearSelection();
      redraw("diff");
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      void saveComment(lines, textarea.value);
    }
  });

  const buttons = document.createElement("div");
  buttons.className = "editor-buttons";
  const save = document.createElement("button");
  save.className = "editor-save";
  save.textContent = "Save ⌘↵";
  save.addEventListener("click", () => void saveComment(lines, textarea.value));
  const cancel = document.createElement("button");
  cancel.className = "editor-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    clearSelection();
    redraw("diff");
  });
  buttons.append(save, cancel);

  box.append(textarea, buttons);
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 0);
  return box;
}

/** Build a trailing section for comments that don't anchor to any rendered
 *  line — their anchor line, or whole file, has left the diff. Keeps them
 *  visible and deletable instead of silently dropping them. Mirrors
 *  claude-commander's TUI orphan handling. */
export function orphanSection(orphans: Comment[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!orphans.length) return frag;
  const header = document.createElement("div");
  header.className = "hunk-header orphan-header";
  header.textContent = "Unanchored comments — lines no longer in the diff";
  frag.appendChild(header);
  for (const c of orphans) frag.appendChild(renderCommentBlock(c));
  return frag;
}
