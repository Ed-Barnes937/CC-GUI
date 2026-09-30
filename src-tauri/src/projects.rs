//! Project management, editor/browser opening, and project shells.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::service::{parse_project_id, parse_session_id, service, with_service};

#[tauri::command]
pub async fn add_project(path: String) -> Result<String, String> {
    let path = expand_tilde(&path);
    with_service(move |svc| async move {
        svc.add_project(PathBuf::from(path), None)
            .await
            .map(|id| id.to_string())
            .map_err(|e| e.to_string())
    })
    .await
}

/// List directories matching `partial` for the add-project / scan path input's
/// live autocomplete. `partial` is the (possibly tilde-prefixed) path typed so
/// far; results are returned in the same tilde form the input used, so the
/// frontend can drop them straight back into the field.
#[tauri::command]
pub fn complete_path(partial: String) -> Vec<String> {
    let expanded = expand_tilde(&partial);
    list_matching_dirs(&expanded)
        .into_iter()
        .map(|p| unexpand_tilde(&partial, &p))
        .collect()
}

#[derive(Serialize)]
pub struct ScanOutcome {
    added: usize,
    skipped: usize,
}

/// Scan a directory tree for git repos and add them all as projects.
#[tauri::command]
pub async fn scan_directory(path: String) -> Result<ScanOutcome, String> {
    let dir = PathBuf::from(expand_tilde(&path));
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }
    with_service(move |svc| async move {
        svc.scan_directory(&dir, None)
            .await
            .map(|r| ScanOutcome {
                added: r.added,
                skipped: r.skipped,
            })
            .map_err(|e| e.to_string())
    })
    .await
}

/// Remove a project and all its sessions (kills tmux sessions, removes
/// worktrees).
#[tauri::command]
pub async fn remove_project(id: String) -> Result<(), String> {
    let id = parse_project_id(&id)?;
    with_service(move |svc| async move {
        svc.session_manager()
            .remove_project(&id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

/// Ensure the project-level shell tmux session exists and return its name.
#[tauri::command]
pub async fn prepare_project_shell(id: String) -> Result<String, String> {
    let id = parse_project_id(&id)?;
    with_service(move |svc| async move {
        svc.session_manager()
            .ensure_project_shell_session(&id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

/// Open a session's worktree in the configured editor (config → $VISUAL →
/// $EDITOR). Terminal editors can't be hosted here, so anything not known to
/// be a GUI editor falls back to the platform opener (Finder/Files).
#[tauri::command]
pub async fn open_in_editor(id: String) -> Result<(), String> {
    let sid = parse_session_id(&id)?;
    let svc = service().await?;
    let worktree = {
        let state = svc.store().read().await;
        state
            .sessions
            .get(&sid)
            .map(|s| s.worktree_path.clone())
            .ok_or("session not found")?
    };
    let config = svc.read_config();
    let editor = config.resolve_editor();
    let use_editor = editor
        .as_deref()
        .map(|e| config.is_gui_editor(e))
        .unwrap_or(false);
    if use_editor {
        let editor = editor.unwrap();
        // The editor config value may carry args (e.g. "code -n").
        let mut parts = editor.split_whitespace();
        let cmd = parts.next().ok_or("empty editor command")?;
        std::process::Command::new(cmd)
            .args(parts)
            .arg(&worktree)
            .spawn()
            .map_err(|e| format!("failed to launch {editor}: {e}"))?;
    } else {
        open_with_platform_opener(worktree.to_string_lossy().as_ref())?;
    }
    Ok(())
}

/// Open a URL (or path) with the platform opener.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open_with_platform_opener(&url)
}

fn open_with_platform_opener(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "linux")]
    let opener = "xdg-open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    std::process::Command::new(opener)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open {target}: {e}"))
}

fn home() -> Option<String> {
    std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned())
}

/// Expand a leading `~` or `~/` to the user's home directory.
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = home() {
            return home;
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home() {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

/// If `original` used a `~` prefix, re-collapse the home prefix in `expanded`
/// so completions are shown in the same form the user typed.
fn unexpand_tilde(original: &str, expanded: &str) -> String {
    if original.starts_with('~') {
        if let Some(home) = home() {
            if let Some(rest) = expanded.strip_prefix(&home) {
                return format!("~{rest}");
            }
        }
    }
    expanded.to_string()
}

/// Split a path into `(parent_dir, partial_name)` at the last `/`.
fn split_path(value: &str) -> (&str, &str) {
    match value.rfind('/') {
        Some(pos) => (&value[..=pos], &value[pos + 1..]),
        None => ("", value),
    }
}

/// List directories inside the parent of `value` whose names start with the
/// trailing partial name. Symlinks are followed only when they resolve to a
/// directory; unreadable parents yield an empty list.
fn list_matching_dirs(value: &str) -> Vec<String> {
    let (parent, partial) = split_path(value);

    let parent_path = if parent.is_empty() {
        Path::new(".")
    } else {
        Path::new(parent)
    };

    let Ok(entries) = std::fs::read_dir(parent_path) else {
        return Vec::new();
    };

    let mut matches: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type()
                .map(|ft| ft.is_dir() || ft.is_symlink())
                .unwrap_or(false)
        })
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(partial) {
                // For symlinks, verify the target is a directory.
                if e.file_type().map(|ft| ft.is_symlink()).unwrap_or(false) && !e.path().is_dir() {
                    return None;
                }
                let full = if parent.is_empty() {
                    name
                } else if parent.ends_with('/') {
                    format!("{parent}{name}")
                } else {
                    format!("{parent}/{name}")
                };
                Some(full)
            } else {
                None
            }
        })
        .collect();

    matches.sort();
    matches
}

#[cfg(test)]
mod tests {
    use super::{list_matching_dirs, split_path};
    use std::fs;

    fn setup_dirs(names: &[&str]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for name in names {
            fs::create_dir_all(tmp.path().join(name)).unwrap();
        }
        tmp
    }

    #[test]
    fn lists_matching_subdirectories_sorted() {
        let tmp = setup_dirs(&["project-a", "project-b", "other"]);
        let got = list_matching_dirs(&format!("{}/project", tmp.path().display()));
        assert_eq!(
            got,
            vec![
                format!("{}/project-a", tmp.path().display()),
                format!("{}/project-b", tmp.path().display()),
            ]
        );
    }

    #[test]
    fn files_are_excluded() {
        let tmp = setup_dirs(&["dir_a"]);
        fs::write(tmp.path().join("file_a"), "x").unwrap();
        let got = list_matching_dirs(&format!("{}/", tmp.path().display()));
        assert_eq!(got, vec![format!("{}/dir_a", tmp.path().display())]);
    }

    #[test]
    fn hidden_dirs_are_included() {
        let tmp = setup_dirs(&[".hidden", "visible"]);
        let got = list_matching_dirs(&format!("{}/.h", tmp.path().display()));
        assert_eq!(got, vec![format!("{}/.hidden", tmp.path().display())]);
    }

    #[test]
    fn unreadable_parent_yields_empty() {
        assert!(list_matching_dirs("/nonexistent_surely_xyz_123/foo").is_empty());
    }

    #[test]
    fn split_path_splits_at_last_slash() {
        assert_eq!(split_path("/home/user/pro"), ("/home/user/", "pro"));
        assert_eq!(split_path("/home/user/"), ("/home/user/", ""));
        assert_eq!(split_path("pro"), ("", "pro"));
    }
}
