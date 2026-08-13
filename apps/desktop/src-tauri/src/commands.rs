use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    file_policy,
    grant::ActiveRoot,
    text_edit::{self, FileSnapshot, ReadTextResult, WriteTextResult},
};

const MAX_NATIVE_READ_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEntry {
    name: String,
    path: PathBuf,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    is_native_bundle: bool,
    size: u64,
    modified: Option<u64>,
    readonly: bool,
    readable: bool,
    can_edit_text: bool,
    can_open_native: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedRoot {
    path: PathBuf,
    entry: NativeEntry,
}

#[tauri::command]
pub async fn pick_root(
    app: tauri::AppHandle,
    root: State<'_, ActiveRoot>,
) -> Result<Option<PickedRoot>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.dialog()
        .file()
        .set_title("Open folder")
        .pick_folder(move |selection| {
            let _ = sender.send(selection);
        });
    let selection = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| "The folder picker did not complete".to_string())?
        .map_err(|_| "The folder picker did not complete".to_string())?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let selected = selection
        .into_path()
        .map_err(|_| "The selected folder is not a local filesystem path".to_string())?;
    let path = root.replace(&selected)?;
    let entry = root.root(directory_entry)?;
    Ok(Some(PickedRoot { path, entry }))
}

#[tauri::command]
pub fn clear_active_root(root: State<'_, ActiveRoot>) -> Result<(), String> {
    root.clear()
}

#[tauri::command]
pub async fn read_dir_native(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
) -> Result<Vec<NativeEntry>, String> {
    let (dir, display) = root.directory(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_directory(&dir, &display))
        .await
        .map_err(|_| "The directory read did not complete".to_string())?
}

#[tauri::command]
pub async fn read_file_native(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let file = root.open_file(&path)?;
    let max_bytes = max_bytes.min(MAX_NATIVE_READ_BYTES);
    let bytes = tauri::async_runtime::spawn_blocking(move || read_bounded_file(file, max_bytes))
        .await
        .map_err(|_| "The file read did not complete".to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn read_text_native(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
) -> Result<ReadTextResult, String> {
    if !file_policy::can_edit_text(&path) {
        return Err("Only recognized UTF-8 text files can be edited".into());
    }
    let file = root.open_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || text_edit::read_text(file))
        .await
        .map_err(|_| "The text read did not complete".to_string())?
}

#[tauri::command]
pub async fn write_text_atomic(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
    text: String,
    expected: FileSnapshot,
) -> Result<WriteTextResult, String> {
    if !file_policy::can_edit_text(&path) {
        return Err("Only recognized UTF-8 text files can be edited".into());
    }
    if text.len() > text_edit::MAX_TEXT_BYTES {
        return Err(format!(
            "Text exceeds the {}-byte editor limit",
            text_edit::MAX_TEXT_BYTES
        ));
    }
    let (dir, relative) = root.scoped(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        text_edit::write_text(&dir, &relative, text.as_bytes(), &expected)
    })
    .await
    .map_err(|_| "The text write did not complete".to_string())?
}

#[tauri::command]
pub fn open_native(
    app: tauri::AppHandle,
    root: State<'_, ActiveRoot>,
    path: PathBuf,
) -> Result<(), String> {
    root.access(&path, |dir, relative| {
        authorize_native_open(dir, relative, &path)
    })?;
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "The selected file path is not valid UTF-8".to_string())?;
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|_| "Could not open the file in its native application".to_string())
}

fn authorize_native_open(
    dir: &cap_std::fs::Dir,
    relative: &Path,
    display_path: &Path,
) -> Result<(), String> {
    let metadata = dir
        .symlink_metadata(relative)
        .map_err(|_| "The selected object is unavailable".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links cannot be opened from FSN".into());
    }
    if metadata.is_dir() && file_policy::can_open_bundle(display_path) {
        return dir
            .open_dir(relative)
            .map(|_| ())
            .map_err(|_| "This application bundle cannot be opened".to_string());
    }
    if metadata.is_file() {
        let file = dir
            .open(relative)
            .map(cap_std::fs::File::into_std)
            .map_err(|_| "This file cannot be opened".to_string())?;
        if file_policy::can_open_native(display_path, is_executable(&file)?) {
            return Ok(());
        }
    }
    Err("Executable and system files cannot be opened from FSN".into())
}

fn read_directory(dir: &cap_std::fs::Dir, display: &Path) -> Result<Vec<NativeEntry>, String> {
    let mut entries = Vec::new();
    for result in dir
        .entries()
        .map_err(|_| "This directory cannot be read".to_string())?
    {
        let entry = result.map_err(|_| "A directory entry could not be read".to_string())?;
        let name = entry.file_name();
        let path = display.join(&name);
        let metadata = entry
            .metadata()
            .map_err(|_| "A directory entry could not be inspected".to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|_| "A directory entry could not be inspected".to_string())?;
        let file = if file_type.is_file() {
            dir.open(&name).ok().map(cap_std::fs::File::into_std)
        } else {
            None
        };
        let is_native_bundle = file_type.is_dir()
            && file_policy::can_open_bundle(&path)
            && dir.open_dir(&name).is_ok();
        let executable = file
            .as_ref()
            .map(is_executable)
            .transpose()?
            .unwrap_or(false);
        entries.push(NativeEntry {
            name: name.to_string_lossy().into_owned(),
            path: path.clone(),
            is_file: file_type.is_file(),
            is_directory: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
            is_native_bundle,
            size: metadata.len(),
            modified: modified_millis(
                metadata
                    .modified()
                    .ok()
                    .map(cap_std::time::SystemTime::into_std),
            ),
            readonly: metadata.permissions().readonly(),
            readable: file.is_some(),
            can_edit_text: file.is_some()
                && !metadata.permissions().readonly()
                && metadata.len() <= text_edit::MAX_TEXT_BYTES as u64
                && file_policy::can_edit_text(&path),
            can_open_native: is_native_bundle
                || file.is_some() && file_policy::can_open_native(&path, executable),
        });
    }
    Ok(entries)
}

fn directory_entry(dir: &cap_std::fs::Dir, display: &Path) -> Result<NativeEntry, String> {
    let metadata = dir
        .dir_metadata()
        .map_err(|_| "The selected folder cannot be inspected".to_string())?;
    Ok(NativeEntry {
        name: display
            .file_name()
            .unwrap_or(display.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: display.to_path_buf(),
        is_file: false,
        is_directory: true,
        is_symlink: false,
        is_native_bundle: false,
        size: metadata.len(),
        modified: modified_millis(
            metadata
                .modified()
                .ok()
                .map(cap_std::time::SystemTime::into_std),
        ),
        readonly: metadata.permissions().readonly(),
        readable: false,
        can_edit_text: false,
        can_open_native: false,
    })
}

fn read_bounded_file(mut file: File, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "This file cannot be inspected".to_string())?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "This file is too large for this viewer ({} bytes; limit is {max_bytes})",
            metadata.len()
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "This file could not be read".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("The file grew beyond this viewer's size limit while it was being read".into());
    }
    Ok(bytes)
}

fn modified_millis(value: Option<std::time::SystemTime>) -> Option<u64> {
    value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_millis()).ok())
}

#[cfg(unix)]
fn is_executable(file: &File) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(file
        .metadata()
        .map_err(|_| "This file cannot be inspected".to_string())?
        .mode()
        & 0o111
        != 0)
}
#[cfg(not(unix))]
fn is_executable(_: &File) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn macos_quit_bridge_ready() -> Result<(), String> {
    crate::macos_quit::mark_ready()
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn macos_quit_bridge_ready() -> Result<(), String> {
    Ok(())
}
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn respond_to_macos_quit(
    app: tauri::AppHandle,
    request_id: u64,
    confirmed: bool,
) -> Result<(), String> {
    crate::macos_quit::respond(app, request_id, confirmed)
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn respond_to_macos_quit(_: tauri::AppHandle, _: u64, _: bool) -> Result<(), String> {
    Err("The application-level quit bridge is only available on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;

    #[cfg(target_os = "macos")]
    #[test]
    fn native_open_accepts_app_bundles_but_not_arbitrary_directories() {
        let base = std::env::temp_dir().join(format!(
            "fsn-native-open-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(base.join("Example.app/Contents")).unwrap();
        std::fs::create_dir(base.join("ordinary")).unwrap();
        let dir = cap_std::fs::Dir::open_ambient_dir(&base, ambient_authority()).unwrap();

        assert!(
            authorize_native_open(&dir, Path::new("Example.app"), &base.join("Example.app"),)
                .is_ok()
        );
        assert!(
            authorize_native_open(&dir, Path::new("ordinary"), &base.join("ordinary"),).is_err()
        );

        std::fs::remove_dir_all(base).unwrap();
    }
}
