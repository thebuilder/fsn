mod commands;
mod file_policy;
mod grant;
#[cfg(target_os = "macos")]
mod macos_quit;
mod text_edit;

use commands::*;
use grant::ActiveRoot;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ActiveRoot::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            macos_quit::install(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_root,
            clear_active_root,
            read_dir_native,
            read_file_native,
            read_text_native,
            write_text_atomic,
            macos_quit_bridge_ready,
            respond_to_macos_quit,
            open_native,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the FSN desktop application");
}
