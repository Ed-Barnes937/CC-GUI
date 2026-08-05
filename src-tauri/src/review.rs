//! Review diff + comment commands.

use base64::Engine;
use claude_commander_core::api::{DiffSide, NewComment};
use claude_commander_core::comment::{ApplyOutcome, CommentSide};

use crate::service::{parse_session_id, with_service};

/// Open the review diff for a session: parsed base→working-tree diff plus the
/// session's re-anchored comments.
#[tauri::command]
pub async fn open_review(id: String) -> Result<claude_commander_core::api::ReviewSnapshot, String> {
    let id = parse_session_id(&id)?;
    with_service(move |svc| async move { svc.open_review(&id).await.map_err(|e| e.to_string()) })
        .await
}

/// Stage a review comment. `side` is "old" or "new"; `line_range` is the
/// inclusive range on that side; `snippet` re-anchors the comment if the diff
/// changes. Returns the new comment's id.
#[tauri::command]
pub async fn create_comment(
    id: String,
    file: String,
    side: String,
    line_range: (usize, usize),
    snippet: String,
    comment: String,
) -> Result<String, String> {
    let id = parse_session_id(&id)?;
    let side = match side.as_str() {
        "old" => CommentSide::Old,
        "new" => CommentSide::New,
        other => return Err(format!("invalid comment side {other:?}")),
    };
    with_service(move |svc| async move {
        let draft = NewComment {
            file,
            side,
            line_range,
            snippet,
            comment,
        };
        svc.create_comment(&id, draft)
            .await
            .map(|uuid| uuid.to_string())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_comment(id: String, comment_id: String) -> Result<(), String> {
    let id = parse_session_id(&id)?;
    let comment_id = uuid::Uuid::parse_str(&comment_id).map_err(|e| e.to_string())?;
    with_service(move |svc| async move {
        svc.delete_comment(&id, comment_id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

/// Read one side of a binary file in the review diff and return its bytes
/// base64-encoded. The frontend wraps this in a `data:<mime>;base64,…` URL
/// using the MIME from the snapshot's `binary` metadata.
///
/// `side` is "old" (the review base) or "new" (the working tree). The service
/// resolves the worktree/base and smudges any git-LFS pointer to real bytes.
#[tauri::command]
pub async fn read_review_image(id: String, path: String, side: String) -> Result<String, String> {
    let sid = parse_session_id(&id)?;
    let side = match side.as_str() {
        "old" => DiffSide::Old,
        "new" => DiffSide::New,
        other => return Err(format!("invalid image side {other:?}")),
    };
    with_service(move |svc| async move {
        let bytes = svc
            .fetch_diff_blob(&sid, side, &path)
            .await
            .map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
}

/// Read one side of a text file in the review diff for hunk expansion, decoding
/// the bytes lossily (files reaching this path already diffed as text; a stray
/// invalid byte degrades to a replacement character rather than failing
/// hydration — see ADR 0002).
///
/// `side` is "old" (the review base) or "new" (the working tree), as in
/// `read_review_image`.
#[tauri::command]
pub async fn read_review_file(id: String, path: String, side: String) -> Result<String, String> {
    let sid = parse_session_id(&id)?;
    let side = match side.as_str() {
        "old" => DiffSide::Old,
        "new" => DiffSide::New,
        other => return Err(format!("invalid file side {other:?}")),
    };
    with_service(move |svc| async move {
        let bytes = svc
            .fetch_diff_blob(&sid, side, &path)
            .await
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
}

/// Toggle the "reviewed" (read) mark on a file in a session's review, returning
/// the file's new reviewed state. The mark is persisted and shared with the TUI,
/// and is keyed on the file's content so it self-invalidates if the file later
/// changes. Re-opens the snapshot to resolve the live `FileDiff` for `path`
/// (a display path) since the mark store hashes the diff.
#[tauri::command]
pub async fn toggle_file_reviewed(id: String, path: String) -> Result<bool, String> {
    let id = parse_session_id(&id)?;
    with_service(move |svc| async move {
        let snapshot = svc.open_review(&id).await.map_err(|e| e.to_string())?;
        let file = snapshot
            .diff
            .files
            .iter()
            .find(|f| f.display_path() == path.as_str())
            .ok_or_else(|| format!("file not in review diff: {path}"))?;
        svc.toggle_file_reviewed(&id, file)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

/// Apply staged comments: composes the markdown brief and injects a pointer
/// prompt into the session's pane (delivery gated on agent state). May block
/// up to the library's hold timeout while a permission prompt clears.
#[tauri::command]
pub async fn apply_comments(id: String) -> Result<ApplyOutcome, String> {
    let id = parse_session_id(&id)?;
    with_service(move |svc| async move { svc.apply_comments(&id).await.map_err(|e| e.to_string()) })
        .await
}
