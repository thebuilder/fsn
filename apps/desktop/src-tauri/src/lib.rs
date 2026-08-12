use std::path::PathBuf;

use tauri_plugin_fs::FsExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_native(app: tauri::AppHandle, path: PathBuf) -> Result<(), String> {
    let scope = app.fs_scope();

    if !scope.is_allowed(&path) {
        return Err("Access to this file is not allowed".into());
    }

    let path = path
        .canonicalize()
        .map_err(|_| "The selected file is unavailable".to_string())?;

    if !scope.is_allowed(&path) {
        return Err("Access to this file is not allowed".into());
    }

    if !path.is_file() {
        return Err("Only files can be opened in a native application".into());
    }

    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "The selected file path is not valid UTF-8".to_string())?;

    app.opener()
        .open_path(path, None::<String>)
        .map_err(|error| format!("Could not open the file: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![open_native])
        .run(tauri::generate_context!())
        .expect("error while running the FSN desktop application");
}
