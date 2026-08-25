#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cascade;
mod commander;
mod files;
mod groups;
mod polling;
mod projects;
mod pty;
mod review;
mod service;
mod sessions;
mod settings;
mod themes;

/// When launched from Finder, a macOS app inherits launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) — missing Homebrew, nvm, etc. — so tools
/// like `tmux` that the embedded claude-commander spawns by bare name fail with
/// ENOENT. Re-derive PATH from the user's login shell so every child process
/// (tmux, git, the terminal shells) sees what the terminal sees.
#[cfg(target_os = "macos")]
fn inherit_login_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let Ok(out) = std::process::Command::new(&shell)
        .args(["-ilc", "printf '__P__%s__P__' \"$PATH\""])
        .output()
    else {
        return;
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let mut parts = s.split("__P__");
    if let (Some(_), Some(path)) = (parts.next(), parts.next()) {
        if !path.is_empty() {
            std::env::set_var("PATH", path);
        }
    }
}

/// macOS sets the locale (`LANG`/`LC_*`) per Terminal session, not in shell rc
/// files, so a Finder-launched app inherits an empty locale. CLIs the embedded
/// claude-commander spawns (the `claude` status line) then assume a non-UTF-8
/// terminal and emit ASCII placeholders (`__`) instead of their Nerd Font icon
/// glyphs. Default `LANG` to the system region's UTF-8 variant when nothing is
/// set, so child processes emit (and the bundled font renders) real glyphs.
#[cfg(target_os = "macos")]
fn ensure_utf8_locale() {
    let is_set = |k| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    if is_set("LC_ALL") || is_set("LC_CTYPE") || is_set("LANG") {
        return;
    }
    // AppleLocale is the macOS system region (e.g. "en_GB"); it can carry extra
    // subtags ("en_GB@currency=GBP") and use either separator, so normalise to a
    // bare `lang_REGION` POSIX name and fall back to en_US when unreadable.
    let region = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok());
    let base = region
        .as_deref()
        .map(|s| s.trim().split('@').next().unwrap_or("").replace('-', "_"))
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or_else(|| "en_US".to_string());
    std::env::set_var("LANG", format!("{base}.UTF-8"));
}

fn main() {
    #[cfg(target_os = "macos")]
    {
        inherit_login_path();
        ensure_utf8_locale();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .setup(|app| {
            groups::spawn_sessions_loop(app.handle().clone());
            polling::spawn_polling_loops();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            groups::get_groups,
            groups::move_to_section,
            sessions::get_session_detail,
            sessions::generate_summary,
            sessions::get_create_options,
            sessions::create_session,
            sessions::kill_session,
            sessions::restart_session,
            sessions::delete_session,
            sessions::rename_session,
            sessions::merged_pr_sessions,
            sessions::prepare_attach,
            sessions::prepare_shell,
            sessions::restart_fresh,
            commander::prepare_commander,
            settings::get_config,
            settings::get_keybindings,
            settings::save_config,
            themes::list_custom_themes,
            themes::save_custom_theme,
            themes::open_themes_dir,
            cascade::cascade_merge,
            cascade::cascade_resume,
            cascade::cascade_abandon,
            cascade::push_stack,
            projects::add_project,
            projects::complete_path,
            projects::scan_directory,
            projects::remove_project,
            projects::prepare_project_shell,
            projects::open_in_editor,
            projects::open_external,
            files::list_session_dir,
            files::list_session_tree,
            files::list_markdown_files,
            files::read_session_file,
            files::read_session_image,
            review::open_review,
            review::read_review_image,
            review::read_review_file,
            review::create_comment,
            review::delete_comment,
            review::toggle_file_reviewed,
            review::apply_comments,
            polling::refresh_pr_status,
            pty::attach,
            pty::write_pty,
            pty::resize_pty,
            pty::detach
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
