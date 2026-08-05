//! Read-only filesystem listing for the file explorer, scoped to a session's
//! worktree. The frontend browses one directory at a time and references files
//! into the terminal as `@path`; nothing here writes to disk.

use std::collections::HashSet;
use std::path::Path;

use base64::Engine;
use serde::Serialize;

use crate::service::{parse_session_id, service, with_service};

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
    let target = resolve_in_root(&root, &sub_path)?;
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
const MD_MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// One markdown file in the viewer's listing.
#[derive(Serialize)]
pub struct MarkdownFile {
    path: String,
    /// Seconds since the Unix epoch; 0 when the mtime is unavailable.
    mtime: u64,
    /// True when the file is in the session's review diff (merge-base vs its
    /// base branch, plus uncommitted changes) — the frontend's relevance signal.
    changed_on_branch: bool,
}

/// The markdown viewer's file listing, changed-on-branch first then newest.
#[derive(Serialize)]
pub struct MarkdownListing {
    files: Vec<MarkdownFile>,
    /// Total matches before the cap; greater than `files.len()` when truncated.
    total: usize,
}

/// Recursively list every `*.md` under a session's worktree for the markdown
/// viewer, skipping dependency/build directories (and hidden directories
/// except `.claude`, where plan/skill docs live), flagging the ones the
/// session's branch changed.
///
/// Ordering here exists only so the `MD_MAX_FILES` cap can never cut a
/// relevant doc: changed-on-branch first, then newest by mtime. The viewer's
/// actual ladder and picker order are pure frontend functions over this
/// listing (`src/markdownRelevance.ts`, ADR-0005); `total` lets the picker say
/// how many were cut.
#[tauri::command]
pub async fn list_markdown_files(session_id: String) -> Result<MarkdownListing, String> {
    let root = session_root(&session_id).await?;
    let changed = changed_markdown_files(&session_id).await;
    let mut files = collect_markdown_files(&root);
    for f in &mut files {
        f.changed_on_branch = changed.contains(&f.path);
    }
    sort_by_relevance(&mut files);
    let total = files.len();
    files.truncate(MD_MAX_FILES);
    Ok(MarkdownListing { files, total })
}

/// The `*.md` paths in a session's review diff, reusing the same machinery the
/// review view does. A session with no resolvable diff (no git base, an
/// unreachable worktree) yields an empty set rather than failing the listing —
/// the viewer then just falls through the ladder to README.
///
/// `open_review` is the only public seam for "what has this session changed",
/// and going through it is what guarantees the viewer's idea of *changed*
/// matches the review view's exactly. It costs more than a filename list: it
/// parses the whole diff, re-anchors the session's comments and prunes reviewed
/// marks the diff has invalidated (both content-keyed, so this only does
/// earlier what opening the review would do anyway), and books a `review.open`
/// telemetry event. A read-only changed-files accessor upstream would let this
/// drop to a name-only diff (tracked in #106); resolving the review base here
/// instead is not worth it, since CC keeps the ref-resolution fallback private
/// and a private copy could disagree with the review view.
async fn changed_markdown_files(session_id: &str) -> HashSet<String> {
    let sid = match parse_session_id(session_id) {
        Ok(sid) => sid,
        Err(_) => return Default::default(),
    };
    let review =
        with_service(
            move |svc| async move { svc.open_review(&sid).await.map_err(|e| e.to_string()) },
        )
        .await;
    match review {
        Ok(snapshot) => snapshot
            .diff
            .files
            .iter()
            .map(|f| f.display_path().to_string())
            .filter(|p| p.to_lowercase().ends_with(".md"))
            .collect(),
        Err(e) => {
            tracing::debug!("markdown listing: no branch diff for {session_id}: {e}");
            Default::default()
        }
    }
}

/// Walk `root` for `*.md` files (skip rules per `list_markdown_files`).
/// `changed_on_branch` starts false; the caller fills it in.
fn collect_markdown_files(root: &Path) -> Vec<MarkdownFile> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.filter_map(|e| e.ok()) {
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
                let mtime = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                files.push(MarkdownFile {
                    path: rel_to_root(root, &path),
                    mtime,
                    changed_on_branch: false,
                });
            }
        }
    }
    files
}

/// Branch-changed docs first, then newest by mtime, ties broken by path — the
/// order the cap is applied over (see `list_markdown_files`).
fn sort_by_relevance(files: &mut [MarkdownFile]) {
    files.sort_by(|a, b| {
        b.changed_on_branch
            .cmp(&a.changed_on_branch)
            .then_with(|| b.mtime.cmp(&a.mtime))
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
}

/// Read one file inside a session's worktree (same escape guard as
/// `list_session_dir`).
#[tauri::command]
pub async fn read_session_file(session_id: String, rel_path: String) -> Result<String, String> {
    let root = session_root(&session_id).await?;
    let target = resolve_in_root(&root, &rel_path)?;
    std::fs::read_to_string(&target).map_err(|e| e.to_string())
}

/// Read one image inside a session's worktree and return its bytes base64-
/// encoded (the frontend builds a `data:` URI; mirrors `read_review_image`).
/// Same escape guard as `read_session_file`; files over `MD_MAX_IMAGE_BYTES`
/// are rejected so a stray huge asset can't balloon the webview.
#[tauri::command]
pub async fn read_session_image(session_id: String, rel_path: String) -> Result<String, String> {
    let root = session_root(&session_id).await?;
    let target = resolve_in_root(&root, &rel_path)?;
    let len = std::fs::metadata(&target).map_err(|e| e.to_string())?.len();
    if len > MD_MAX_IMAGE_BYTES {
        return Err(format!("image too large ({len} bytes)"));
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
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

/// Resolve `rel_path` inside a canonicalized `root`, rejecting anything that
/// escapes it — `..` and out-of-tree symlinks canonicalize to a path outside
/// `root` and are refused.
fn resolve_in_root(root: &Path, rel_path: &str) -> Result<std::path::PathBuf, String> {
    let target = root
        .join(rel_path)
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    if !target.starts_with(root) {
        return Err("path is outside the repository".into());
    }
    Ok(target)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn set_mtime(path: &Path, secs_ago: u64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[test]
    fn collect_markdown_files_skips_noise_and_sorts_relevant_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for d in ["docs", "node_modules", ".claude", ".hidden"] {
            fs::create_dir(root.join(d)).unwrap();
        }
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join("docs/plan.md"), "").unwrap();
        fs::write(root.join(".claude/skill.md"), "").unwrap();
        fs::write(root.join("node_modules/dep.md"), "").unwrap();
        fs::write(root.join(".hidden/nope.md"), "").unwrap();
        fs::write(root.join("notes.txt"), "").unwrap();
        set_mtime(&root.join("docs/plan.md"), 0);
        set_mtime(&root.join("README.md"), 100);
        set_mtime(&root.join(".claude/skill.md"), 200);

        let mut files = collect_markdown_files(&root);
        sort_by_relevance(&mut files);
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["docs/plan.md", "README.md", ".claude/skill.md"]);
        assert!(files[0].mtime >= files[1].mtime);

        // A branch-changed doc outranks newer untouched ones, so the cap can
        // only ever drop the irrelevant tail.
        files
            .iter_mut()
            .find(|f| f.path == ".claude/skill.md")
            .unwrap()
            .changed_on_branch = true;
        sort_by_relevance(&mut files);
        assert_eq!(files[0].path, ".claude/skill.md");
    }

    #[test]
    fn resolve_in_root_accepts_inside_and_rejects_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("repo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("doc.md"), "").unwrap();
        fs::write(base.join("outside.md"), "").unwrap();

        assert!(resolve_in_root(&root, "doc.md").is_ok());
        assert!(resolve_in_root(&root, "../outside.md").is_err());
        assert!(resolve_in_root(&root, "absent.md").is_err());
    }
}
