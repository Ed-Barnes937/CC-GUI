//! Read-only filesystem listing for the file explorer, scoped to a session's
//! worktree. The frontend browses one directory at a time and references files
//! into the terminal as `@path`; nothing here writes to disk.

use std::path::Path;

use serde::Serialize;

use crate::service::{parse_session_id, service};

/// One entry in a listed directory. `size` is 0 for directories.
#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

/// A single directory level, relative to the session's worktree root.
#[derive(Serialize)]
pub struct DirListing {
    /// Path of the listed directory relative to the worktree root, using `/`
    /// separators. Empty at the root.
    rel_path: String,
    at_root: bool,
    entries: Vec<FsEntry>,
}

/// List one directory level inside a session's worktree.
///
/// `sub_path` is relative to the worktree root (empty for the root). The
/// resolved path is canonicalized and rejected if it escapes the root, so `..`
/// and out-of-tree symlinks can't be used to browse outside the repo.
#[tauri::command]
pub async fn list_session_dir(
    session_id: String,
    sub_path: String,
    show_hidden: bool,
) -> Result<DirListing, String> {
    let sid = parse_session_id(&session_id)?;
    let svc = service().await?;
    let worktree = {
        let state = svc.store().read().await;
        state
            .sessions
            .get(&sid)
            .map(|s| s.worktree_path.clone())
            .ok_or("session not found")?
    };

    let root = worktree
        .canonicalize()
        .map_err(|e| format!("cannot resolve worktree: {e}"))?;
    let target = root.join(sub_path);
    let target = target
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    if !target.starts_with(&root) {
        return Err("path is outside the repository".into());
    }
    if !target.is_dir() {
        return Err(format!("not a directory: {}", target.display()));
    }

    let mut entries: Vec<FsEntry> = std::fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !show_hidden && name.starts_with('.') {
                return None;
            }
            let ft = e.file_type().ok()?;
            // Follow symlinks only to decide whether they're a directory; the
            // canonicalize guard above rejects any that resolve outside root
            // once navigated into.
            let is_dir = if ft.is_symlink() {
                e.path().is_dir()
            } else {
                ft.is_dir()
            };
            let size = if is_dir {
                0
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            };
            Some(FsEntry { name, is_dir, size })
        })
        .collect();

    // Directories first, then case-insensitive by name.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let rel_path = rel_to_root(&root, &target);
    Ok(DirListing {
        at_root: rel_path.is_empty(),
        rel_path,
        entries,
    })
}

const MD_SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".git"];
const MD_MAX_FILES: usize = 500;

/// Recursively list every `*.md` under a session's worktree for the markdown
/// viewer, skipping dependency/build directories (and hidden directories
/// except `.claude`, where plan/skill docs live), capped at `MD_MAX_FILES`.
#[tauri::command]
pub async fn list_markdown_files(session_id: String) -> Result<Vec<String>, String> {
    let root = session_root(&session_id).await?;
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.filter_map(|e| e.ok()) {
            if out.len() >= MD_MAX_FILES {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !MD_SKIP_DIRS.contains(&name.as_str())
                    && (!name.starts_with('.') || name == ".claude")
                {
                    stack.push(path);
                }
            } else if name.to_lowercase().ends_with(".md") {
                out.push(rel_to_root(&root, &path));
            }
        }
    }
    out.sort_by_key(|p| p.to_lowercase());
    Ok(out)
}

/// Read one file inside a session's worktree (same escape guard as
/// `list_session_dir`).
#[tauri::command]
pub async fn read_session_file(session_id: String, rel_path: String) -> Result<String, String> {
    let root = session_root(&session_id).await?;
    let target = root
        .join(rel_path)
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    if !target.starts_with(&root) {
        return Err("path is outside the repository".into());
    }
    std::fs::read_to_string(&target).map_err(|e| e.to_string())
}

/// Resolve a session's canonicalized worktree root.
async fn session_root(session_id: &str) -> Result<std::path::PathBuf, String> {
    let sid = parse_session_id(session_id)?;
    let svc = service().await?;
    let worktree = {
        let state = svc.store().read().await;
        state
            .sessions
            .get(&sid)
            .map(|s| s.worktree_path.clone())
            .ok_or("session not found")?
    };
    worktree
        .canonicalize()
        .map_err(|e| format!("cannot resolve worktree: {e}"))
}

/// `target` relative to `root`, with `/` separators. Empty when equal.
fn rel_to_root(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .ok()
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}
