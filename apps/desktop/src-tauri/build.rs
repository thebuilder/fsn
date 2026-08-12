fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_root",
            "require_active_root",
            "clear_active_root",
            "read_dir_native",
            "stat_native",
            "read_file_native",
            "read_text_native",
            "write_text_atomic",
            "macos_quit_bridge_ready",
            "respond_to_macos_quit",
            "open_native",
        ]),
    ))
    .expect("failed to build the Tauri application");
}
