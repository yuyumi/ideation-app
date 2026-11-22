// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod boards;
mod chat;
mod claude;
mod error;
mod git;
mod github;
mod pilots;
mod process;
mod settings;
mod store;
mod threads;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};

use boards::BoardInfo;
use chat::{ChatEvent, ChatRequest, Running};
use github::{GhStatus, RemoteStatus};
use error::{AppError, Result};
use pilots::{Activity, DeleteInfo, FileChange, FileContent, PilotFile, PilotMeta, RunConfig};
use settings::{PilotPermission, Settings, WindowSettings};
use store::{RecentBoard, Store};

struct AppState {
    store: Store,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    /// Located `claude` executable and its version, cached until settings change.
    claude_exe: Mutex<Option<(PathBuf, String)>>,
    running_chats: Running,
    pilots: Arc<pilots::Manager>,
}

impl AppState {
    fn claude(&self) -> Result<(PathBuf, String)> {
        if let Some(found) = self.claude_exe.lock().unwrap().clone() {
            return Ok(found);
        }
        let override_path = self.settings.lock().unwrap().claude.path.clone();
        let found = claude::locate(&override_path).ok_or_else(|| {
            AppError::msg("Claude Code was not found. Install it, or set its path in Settings.")
        })?;
        *self.claude_exe.lock().unwrap() = Some(found.clone());
        Ok(found)
    }

    fn claude_exe(&self) -> Result<PathBuf> {
        Ok(self.claude()?.0)
    }

    fn pilot_config(&self) -> Result<RunConfig> {
        let (claude_exe, version) = self.claude()?;
        Ok(RunConfig {
            claude_exe,
            permission_prompts_flag: claude::supports_permission_prompts_flag(&version),
            max_concurrent: self.settings.lock().unwrap().pilots.max_concurrent,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    git: Option<String>,
    claude: Option<String>,
    claude_path: Option<String>,
}

#[tauri::command]
async fn check_environment(state: State<'_, AppState>) -> Result<Environment> {
    let override_path = state.settings.lock().unwrap().claude.path.clone();
    let claude = claude::locate(&override_path);
    Ok(Environment {
        git: git::version(),
        claude_path: claude.as_ref().map(|(p, _)| p.display().to_string()),
        claude: claude.map(|(_, v)| v),
    })
}

#[tauri::command]
async fn list_recent_boards(state: State<'_, AppState>) -> Result<Vec<RecentBoard>> {
    state.store.list()
}

#[tauri::command]
async fn forget_board(state: State<'_, AppState>, path: String) -> Result<()> {
    state.store.forget(&path)
}

#[tauri::command]
async fn create_board(state: State<'_, AppState>, parent: String, name: String) -> Result<BoardInfo> {
    let info = boards::create(&PathBuf::from(parent), &name)?;
    state.store.touch(&info.path, &info.meta.name)?;
    Ok(info)
}

#[tauri::command]
async fn open_board(state: State<'_, AppState>, path: String) -> Result<BoardInfo> {
    let info = boards::open(&PathBuf::from(path))?;
    state.store.touch(&info.path, &info.meta.name)?;
    Ok(info)
}

#[tauri::command]
async fn load_scene(path: String) -> Result<String> {
    boards::load_scene(&PathBuf::from(path))
}

#[tauri::command]
async fn save_scene(path: String, scene: String) -> Result<()> {
    boards::save_scene(&PathBuf::from(path), &scene)
}

#[tauri::command]
async fn commit_board(path: String, message: String) -> Result<bool> {
    boards::commit(&PathBuf::from(path), &message)
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings> {
    Ok(state.settings.lock().unwrap().clone())
}

/// Validates, saves and immediately applies new settings.
#[tauri::command]
async fn save_settings(window: WebviewWindow, state: State<'_, AppState>, settings: Settings) -> Result<Settings> {
    settings::save(&state.settings_path, &settings)?;
    *state.settings.lock().unwrap() = settings.clone();
    *state.claude_exe.lock().unwrap() = None; // re-locate with the new path
    place_window(&window, &settings.window).map_err(|e| AppError::msg(format!("could not move window: {e}")))?;
    Ok(settings)
}

/// Current window size in the same logical-pixel units the settings use.
#[tauri::command]
async fn current_window_size(window: WebviewWindow) -> Result<(f64, f64)> {
    let err = |e: tauri::Error| AppError::msg(e.to_string());
    let scale = window.scale_factor().map_err(err)?;
    let size = window.inner_size().map_err(err)?.to_logical::<f64>(scale);
    Ok((size.width.round(), size.height.round()))
}

// ---- Chat ----

/// Runs one chat turn. Events stream through `on_event`; the call returns
/// when Claude finishes, fails or is cancelled.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    request_id: String,
    board_path: String,
    session_id: Option<String>,
    prompt: String,
    on_event: Channel<ChatEvent>,
) -> Result<()> {
    let state = app.state::<AppState>();
    let claude_exe = state.claude_exe()?;
    let cfg = state.settings.lock().unwrap().claude.clone();
    let req = ChatRequest {
        board_path: PathBuf::from(board_path),
        prompt,
        session_id,
        model: cfg.model,
        repo_access: cfg.repo_access,
        claude_exe,
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        chat::run(req, &request_id, &state.running_chats, |ev| {
            let _ = on_event.send(ev);
        })
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
async fn chat_cancel(state: State<'_, AppState>, request_id: String) -> Result<bool> {
    Ok(state.running_chats.cancel(&request_id))
}

#[tauri::command]
async fn list_threads(board_path: String) -> Result<Vec<threads::ThreadSummary>> {
    threads::list(&PathBuf::from(board_path))
}

#[tauri::command]
async fn load_thread(board_path: String, id: String) -> Result<serde_json::Value> {
    threads::load(&PathBuf::from(board_path), &id)
}

#[tauri::command]
async fn save_thread(board_path: String, thread: serde_json::Value) -> Result<()> {
    threads::save(&PathBuf::from(board_path), &thread)
}

#[tauri::command]
async fn delete_thread(board_path: String, id: String) -> Result<()> {
    threads::delete(&PathBuf::from(board_path), &id)
}

// ---- GitHub ----

#[tauri::command]
async fn github_status() -> GhStatus {
    github::status()
}

#[tauri::command]
async fn github_login() -> Result<()> {
    github::login_in_terminal()
}

#[tauri::command]
async fn github_owners() -> Result<Vec<String>> {
    github::owners()
}

#[tauri::command]
async fn repo_remote_status(path: String) -> Result<RemoteStatus> {
    github::remote_status(&PathBuf::from(path))
}

#[tauri::command]
async fn repo_fetch(path: String) -> Result<RemoteStatus> {
    github::fetch(&PathBuf::from(path))
}

#[tauri::command]
async fn repo_publish(path: String, owner: String, name: String, private: bool, description: String) -> Result<RemoteStatus> {
    github::publish(&PathBuf::from(path), &owner, &name, private, &description)
}

#[tauri::command]
async fn repo_push(path: String) -> Result<RemoteStatus> {
    github::push(&PathBuf::from(path))
}

#[tauri::command]
async fn repo_pull(path: String) -> Result<RemoteStatus> {
    github::pull(&PathBuf::from(path))
}

// ---- Pilots ----

#[tauri::command]
async fn pilots_list(state: State<'_, AppState>, board_path: String) -> Result<Vec<PilotMeta>> {
    Ok(state.pilots.list(&PathBuf::from(board_path)))
}

#[tauri::command]
async fn pilot_get(board_path: String, id: String) -> Result<PilotMeta> {
    pilots::load_meta(&PathBuf::from(board_path), &id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn pilot_start(
    app: AppHandle,
    board_path: String,
    title: String,
    instructions: String,
    prompt: String,
    scope: String,
    model: String,
    permission: PilotPermission,
    max_budget_usd: f64,
    max_turns: u32,
) -> Result<PilotMeta> {
    let state = app.state::<AppState>();
    let cfg = state.pilot_config()?;
    state.pilots.start(
        &app,
        cfg,
        &PathBuf::from(board_path),
        &title,
        &instructions,
        prompt,
        &scope,
        &model,
        permission,
        max_budget_usd,
        max_turns,
    )
}

#[tauri::command]
async fn pilot_follow_up(app: AppHandle, board_path: String, id: String, instructions: String, prompt: String) -> Result<PilotMeta> {
    let state = app.state::<AppState>();
    let cfg = state.pilot_config()?;
    state.pilots.follow_up(&app, cfg, &PathBuf::from(board_path), &id, &instructions, prompt)
}

#[tauri::command]
async fn pilot_start_again(app: AppHandle, board_path: String, id: String) -> Result<PilotMeta> {
    let state = app.state::<AppState>();
    let cfg = state.pilot_config()?;
    state.pilots.start_again(&app, cfg, &PathBuf::from(board_path), &id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveWork {
    pilots: usize,
    chats: usize,
}

/// Pilots and chat replies still running, so closing the app can ask first.
#[tauri::command]
async fn active_work(state: State<'_, AppState>) -> Result<ActiveWork> {
    Ok(ActiveWork { pilots: state.pilots.active_count(), chats: state.running_chats.count() })
}

/// Stops all running work before the app closes. Pilots become Interrupted.
#[tauri::command]
async fn stop_all_work(state: State<'_, AppState>) -> Result<()> {
    state.pilots.stop_all();
    state.running_chats.cancel_all();
    Ok(())
}

#[tauri::command]
async fn pilot_cancel(app: AppHandle, board_path: String, id: String) -> Result<()> {
    app.state::<AppState>().pilots.cancel(&app, &PathBuf::from(board_path), &id)
}

#[tauri::command]
async fn pilot_delete_info(board_path: String, id: String) -> Result<DeleteInfo> {
    pilots::delete_info(&PathBuf::from(board_path), &id)
}

/// Deletes the pilot's worktree, branch and records. The UI confirms first.
#[tauri::command]
async fn pilot_delete(app: AppHandle, board_path: String, id: String) -> Result<()> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || app2.state::<AppState>().pilots.delete(&app2, &PathBuf::from(board_path), &id))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
async fn pilot_set_pinned(board_path: String, id: String, pinned: bool) -> Result<PilotMeta> {
    pilots::set_pinned(&PathBuf::from(board_path), &id, pinned)
}

#[tauri::command]
async fn pilot_activity(board_path: String, id: String) -> Result<Vec<Activity>> {
    pilots::activity(&PathBuf::from(board_path), &id)
}

#[tauri::command]
async fn pilot_changes(board_path: String, id: String) -> Result<Vec<FileChange>> {
    pilots::changes(&PathBuf::from(board_path), &id)
}

#[tauri::command]
async fn pilot_file_diff(board_path: String, id: String, path: String) -> Result<String> {
    pilots::file_diff(&PathBuf::from(board_path), &id, &path)
}

#[tauri::command]
async fn pilot_results(board_path: String, id: String) -> Result<Vec<PilotFile>> {
    pilots::result_files(&PathBuf::from(board_path), &id)
}

#[tauri::command]
async fn pilot_read_file(board_path: String, id: String, path: String) -> Result<FileContent> {
    pilots::read_file(&PathBuf::from(board_path), &id, &path)
}

#[tauri::command]
async fn pilot_push(board_path: String, id: String) -> Result<()> {
    pilots::push(&PathBuf::from(board_path), &id)
}

#[tauri::command]
async fn pilot_worktree_path(board_path: String, id: String) -> Result<String> {
    Ok(pilots::worktree(&PathBuf::from(board_path), &id).display().to_string())
}

/// Sizes the window from the settings and places it relative to its monitor:
/// centered horizontally, with the configured gap above the title bar.
fn place_window(window: &WebviewWindow, s: &WindowSettings) -> tauri::Result<()> {
    window.set_size(LogicalSize::new(s.width, s.height))?;
    let monitor = match window.current_monitor()? {
        Some(m) => Some(m),
        None => window.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        // Work area = screen minus the taskbar, in physical pixels.
        let area = monitor.work_area();
        let (area_w, area_h) = (area.size.width as f64, area.size.height as f64);
        let outer_w = window.outer_size()?.width as f64;

        let x = area.position.x as f64 + ((area_w - outer_w) / 2.0).max(0.0);
        let y = area.position.y as f64 + area_h * s.top_gap_percent / 100.0;
        window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch focuses the running window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| AppError::msg(format!("no app data dir: {e}")))?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("ideation.db"))?;
            let settings_path = dir.join("settings.json");
            let settings = settings::load(&settings_path);

            // The window starts hidden (tauri.conf.json) so it never flashes
            // at a default position before being placed.
            if let Some(window) = app.get_webview_window("main") {
                place_window(&window, &settings.window)?;
                window.show()?;
                window.set_focus()?;
            }
            app.manage(AppState {
                store,
                settings: Mutex::new(settings),
                settings_path,
                claude_exe: Mutex::new(None),
                running_chats: Running::default(),
                pilots: Arc::new(pilots::Manager::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_environment,
            list_recent_boards,
            forget_board,
            create_board,
            open_board,
            load_scene,
            save_scene,
            commit_board,
            get_settings,
            save_settings,
            current_window_size,
            chat_send,
            chat_cancel,
            list_threads,
            load_thread,
            save_thread,
            delete_thread,
            github_status,
            github_login,
            github_owners,
            repo_remote_status,
            repo_fetch,
            repo_publish,
            repo_push,
            repo_pull,
            pilots_list,
            pilot_get,
            pilot_start,
            pilot_follow_up,
            pilot_cancel,
            pilot_delete_info,
            pilot_delete,
            pilot_set_pinned,
            pilot_activity,
            pilot_changes,
            pilot_file_diff,
            pilot_results,
            pilot_read_file,
            pilot_push,
            pilot_worktree_path,
            pilot_start_again,
            active_work,
            stop_all_work
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ideation");
}
