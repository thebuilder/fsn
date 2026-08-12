use std::{
    fs::{self, File, Metadata},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::UNIX_EPOCH,
};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
mod macos_quit;

const HASH_BUFFER_BYTES: usize = 64 * 1024;
const MAX_TEXT_WRITE_BYTES: usize = 2_000_000;
const MAX_NATIVE_READ_BYTES: u64 = 256 * 1024 * 1024;
const BLOCKED_NATIVE_OPEN_EXTENSIONS: &[&str] = &[
    "app", "bat", "bin", "cmd", "com", "command", "cpl", "dat", "desktop", "dll", "dylib", "exe",
    "hta", "lnk", "msi", "pkg", "ps1", "reg", "scr", "sh", "so", "vbs",
];
const TEXT_EXTENSIONS: &[&str] = &[
    "adoc",
    "asciidoc",
    "asm",
    "astro",
    "avdl",
    "avsc",
    "awk",
    "bash",
    "bat",
    "bazel",
    "bzl",
    "c",
    "cc",
    "cfg",
    "cjs",
    "clj",
    "cljs",
    "cmake",
    "cmd",
    "cnf",
    "coffee",
    "conf",
    "cpp",
    "cs",
    "cshtml",
    "csproj",
    "css",
    "cts",
    "cu",
    "cue",
    "cuh",
    "csv",
    "cxx",
    "d",
    "dart",
    "diff",
    "dockerfile",
    "ejs",
    "elm",
    "env",
    "erb",
    "erl",
    "ex",
    "exs",
    "feature",
    "fish",
    "frag",
    "fs",
    "fsi",
    "fsproj",
    "fsx",
    "geojson",
    "glsl",
    "go",
    "gql",
    "gradle",
    "graphql",
    "graphqls",
    "groovy",
    "h",
    "handlebars",
    "har",
    "hbs",
    "hcl",
    "hh",
    "hpp",
    "hs",
    "html",
    "http",
    "hxx",
    "ics",
    "ini",
    "ipynb",
    "java",
    "jl",
    "js",
    "json",
    "json5",
    "jsonc",
    "jsonl",
    "jsx",
    "kt",
    "kts",
    "less",
    "liquid",
    "log",
    "lua",
    "m",
    "markdown",
    "md",
    "mdown",
    "mdx",
    "metal",
    "mjs",
    "mkd",
    "mm",
    "mts",
    "mustache",
    "ndjson",
    "nfo",
    "nim",
    "nix",
    "njk",
    "nomad",
    "org",
    "pas",
    "patch",
    "php",
    "pl",
    "po",
    "pot",
    "prisma",
    "properties",
    "props",
    "proto",
    "ps1",
    "pug",
    "py",
    "qmd",
    "r",
    "razor",
    "rb",
    "rego",
    "resx",
    "rmd",
    "robot",
    "rs",
    "rst",
    "rtf",
    "sass",
    "scala",
    "scss",
    "sed",
    "service",
    "sh",
    "shader",
    "sln",
    "sol",
    "sql",
    "srt",
    "storyboard",
    "styl",
    "svelte",
    "swift",
    "targets",
    "tcl",
    "tex",
    "text",
    "tf",
    "tfstate",
    "tfvars",
    "thrift",
    "toml",
    "ts",
    "tsv",
    "tsx",
    "twig",
    "txt",
    "v",
    "vb",
    "vbproj",
    "vbs",
    "vcxproj",
    "vert",
    "vhd",
    "vhdl",
    "vtt",
    "vue",
    "wat",
    "webmanifest",
    "wgsl",
    "wit",
    "xaml",
    "xcconfig",
    "xib",
    "xlf",
    "xliff",
    "xml",
    "xsd",
    "xslt",
    "yaml",
    "yml",
    "zig",
    "zsh",
];
const TEXT_FILENAMES: &[&str] = &[
    ".babelrc",
    ".browserslistrc",
    ".commitlintrc",
    ".dockerignore",
    ".editorconfig",
    ".env",
    ".envrc",
    ".eslintignore",
    ".eslintrc",
    ".gitattributes",
    ".gitignore",
    ".gitkeep",
    ".gitmodules",
    ".htaccess",
    ".lintstagedrc",
    ".mailmap",
    ".node-version",
    ".npmignore",
    ".npmrc",
    ".nvmrc",
    ".prettierignore",
    ".prettierrc",
    ".python-version",
    ".ruby-version",
    ".stylelintignore",
    ".stylelintrc",
    ".swcrc",
    ".tool-versions",
    ".watchmanconfig",
    ".yarnrc",
    "authors",
    "brewfile",
    "buck",
    "cargo.lock",
    "changelog",
    "changes",
    "codeowners",
    "composer.lock",
    "containerfile",
    "contributing",
    "contributors",
    "copying",
    "dockerfile",
    "flake.lock",
    "gemfile",
    "gemfile.lock",
    "go.mod",
    "go.sum",
    "gradlew",
    "install",
    "jenkinsfile",
    "justfile",
    "license",
    "licence",
    "makefile",
    "meson.build",
    "mvnw",
    "news",
    "notice",
    "pipfile",
    "pipfile.lock",
    "podfile",
    "poetry.lock",
    "procfile",
    "rakefile",
    "readme",
    "security",
    "todo",
    "vagrantfile",
    "version",
    "workspace",
    "yarn.lock",
];

#[derive(Default)]
struct ActiveRoot(Mutex<Option<PathBuf>>);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    size: u64,
    modified: Option<u64>,
    // Decimal text avoids losing nanosecond precision through JavaScript JSON numbers.
    modified_ns: Option<String>,
    identity: String,
    sha256: String,
    security_metadata: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum WriteTextResult {
    Saved { snapshot: FileSnapshot },
    Conflict { actual: FileSnapshot },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEntry {
    name: String,
    path: PathBuf,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    size: u64,
    modified: Option<u64>,
    readonly: bool,
    readable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeMetadata {
    size: u64,
    modified: Option<u64>,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    readonly: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadTextResult {
    bytes: Vec<u8>,
    snapshot: FileSnapshot,
}

#[tauri::command]
async fn pick_root(
    app: tauri::AppHandle,
    root: State<'_, ActiveRoot>,
) -> Result<Option<PathBuf>, String> {
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
    let canonical = canonical_directory(&selected)?;
    *active_root(&root)? = Some(canonical.clone());
    Ok(Some(canonical))
}

/// A recent path from the webview is never authority. It is accepted only when
/// it exactly identifies the folder already authorized in this native session.
#[tauri::command]
fn require_active_root(root: State<'_, ActiveRoot>, path: PathBuf) -> Result<PathBuf, String> {
    let canonical = canonical_directory(&path)?;
    let active = active_root(&root)?;
    match active.as_ref() {
        Some(expected) if expected == &canonical => Ok(canonical),
        _ => Err("This folder is not authorized in the current desktop session".into()),
    }
}

#[tauri::command]
fn clear_active_root(root: State<'_, ActiveRoot>) -> Result<(), String> {
    *active_root(&root)? = None;
    Ok(())
}

#[tauri::command]
async fn read_dir_native(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
) -> Result<Vec<NativeEntry>, String> {
    let path = authorized_directory(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || read_directory(&path))
        .await
        .map_err(|_| "The directory read did not complete".to_string())?
}

fn read_directory(path: &Path) -> Result<Vec<NativeEntry>, String> {
    let mut entries = Vec::new();
    for result in fs::read_dir(path).map_err(|_| "This directory cannot be read".to_string())? {
        let entry = result.map_err(|_| "A directory entry could not be read".to_string())?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| "A directory entry could not be inspected".to_string())?;
        let file_type = metadata.file_type();
        let readable = file_type.is_file() && File::open(entry.path()).is_ok();
        let native = native_metadata(&metadata);
        entries.push(NativeEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path(),
            is_file: file_type.is_file(),
            is_directory: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: native.size,
            modified: native.modified,
            readonly: native.readonly,
            readable,
        });
    }
    Ok(entries)
}

#[tauri::command]
fn stat_native(root: State<'_, ActiveRoot>, path: PathBuf) -> Result<NativeMetadata, String> {
    let (path, metadata) = authorized_entry(&root, &path)?;
    let _ = path;
    Ok(native_metadata(&metadata))
}

#[tauri::command]
async fn read_file_native(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let (path, metadata) = authorized_regular_file(&root, &path)?;
    let max_bytes = max_bytes.min(MAX_NATIVE_READ_BYTES);
    if metadata.len() > max_bytes {
        return Err(format!(
            "This file is too large for this viewer ({} bytes; limit is {max_bytes})",
            metadata.len()
        ));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || read_bounded_file(&path, max_bytes))
        .await
        .map_err(|_| "The file read did not complete".to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn read_bounded_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|_| "This file cannot be inspected".to_string())?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "This file is too large for this viewer ({} bytes; limit is {max_bytes})",
            metadata.len()
        ));
    }
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| "This file is too large to read".to_string())?;
    let mut file = File::open(path).map_err(|_| "This file cannot be opened".to_string())?;
    ensure_open_file_still_matches(path, &file)?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "This file could not be read".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("The file grew beyond this viewer's size limit while it was being read".into());
    }
    ensure_open_file_still_matches(path, &file)?;
    Ok(bytes)
}

#[tauri::command]
async fn read_text_native(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
) -> Result<ReadTextResult, String> {
    let (path, metadata) = authorized_regular_file(&root, &path)?;
    ensure_text_path(&path)?;
    if metadata.len() > MAX_TEXT_WRITE_BYTES as u64 {
        return Err(format!(
            "Text files are limited to {MAX_TEXT_WRITE_BYTES} bytes"
        ));
    }
    tauri::async_runtime::spawn_blocking(move || read_text_checked(&path))
        .await
        .map_err(|_| "The text read did not complete".to_string())?
}

#[tauri::command]
async fn write_text_atomic(
    root: State<'_, ActiveRoot>,
    path: PathBuf,
    text: String,
    expected: FileSnapshot,
) -> Result<WriteTextResult, String> {
    let bytes = text.as_bytes();
    if bytes.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!(
            "Text exceeds the {MAX_TEXT_WRITE_BYTES}-byte editor limit"
        ));
    }
    let (path, metadata) = authorized_regular_file(&root, &path)?;
    ensure_text_path(&path)?;
    if metadata.permissions().readonly() {
        return Err("This file is read-only".into());
    }
    let bytes = bytes.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        write_text_checked(&path, &bytes, &expected, || Ok(()))
    })
    .await
    .map_err(|_| "The text write did not complete".to_string())?
}

#[tauri::command]
fn macos_quit_bridge_ready() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_quit::mark_ready()
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
fn respond_to_macos_quit(
    app: tauri::AppHandle,
    request_id: u64,
    confirmed: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_quit::respond(app, request_id, confirmed)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request_id, confirmed);
        Err("The application-level quit bridge is only available on macOS".into())
    }
}

#[tauri::command]
fn open_native(
    app: tauri::AppHandle,
    root: State<'_, ActiveRoot>,
    path: PathBuf,
) -> Result<(), String> {
    let (path, metadata) = authorized_regular_file(&root, &path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_deref()
        .is_some_and(|value| BLOCKED_NATIVE_OPEN_EXTENSIONS.contains(&value))
    {
        return Err("Executable and system files cannot be opened from FSN".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o111 != 0 {
            return Err("Executable files cannot be opened from FSN".into());
        }
    }
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "The selected file path is not valid UTF-8".to_string())?;
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|_| "Could not open the file in its native application".to_string())
}

fn write_text_checked<F>(
    path: &Path,
    bytes: &[u8],
    expected: &FileSnapshot,
    before_commit: F,
) -> Result<WriteTextResult, String>
where
    F: FnOnce() -> io::Result<()>,
{
    let (mut source, actual) = open_and_snapshot(path)?;
    if &actual != expected {
        return Ok(WriteTextResult::Conflict { actual });
    }

    // Opening AtomicWriteFile creates a sibling replacement and preserves the
    // existing Unix mode/owner. The original remains visible until commit.
    let mut replacement = AtomicWriteFile::open(path)
        .map_err(|_| "A replacement file could not be prepared".to_string())?;
    replacement
        .write_all(bytes)
        .and_then(|_| replacement.flush())
        .map_err(|_| "The edited file could not be flushed safely".to_string())?;
    preserve_extended_metadata(&source, &replacement)?;
    replacement
        .sync_all()
        .map_err(|_| "The edited file could not be flushed safely".to_string())?;

    before_commit().map_err(|_| "The edited file could not be committed safely".to_string())?;

    // Hash the still-open original immediately before commit. This catches
    // same-size/same-mtime edits and replacement of the path since the editor's
    // snapshot. The active path is checked again to catch rename/symlink races.
    let pre_commit = snapshot_from_open_file(path, &mut source)?;
    let current = snapshot_path(path)?;
    if pre_commit != actual || current != actual {
        return Ok(WriteTextResult::Conflict { actual: current });
    }

    replacement
        .commit()
        .map_err(|_| "The edited file could not be committed safely".to_string())?;
    let saved = snapshot_path(path)?;
    Ok(WriteTextResult::Saved { snapshot: saved })
}

fn active_root<'a>(
    root: &'a State<'_, ActiveRoot>,
) -> Result<MutexGuard<'a, Option<PathBuf>>, String> {
    root.0
        .lock()
        .map_err(|_| "The desktop filesystem session is unavailable".to_string())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "The selected folder is unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The selected path is not a regular directory".into());
    }
    path.canonicalize()
        .map_err(|_| "The selected folder is unavailable".to_string())
}

fn authorized_directory(root: &State<'_, ActiveRoot>, path: &Path) -> Result<PathBuf, String> {
    let (path, metadata) = authorized_entry(root, path)?;
    if !metadata.is_dir() {
        return Err("Only regular directories can be traversed".into());
    }
    Ok(path)
}

fn authorized_regular_file(
    root: &State<'_, ActiveRoot>,
    path: &Path,
) -> Result<(PathBuf, Metadata), String> {
    let (path, metadata) = authorized_entry(root, path)?;
    if !metadata.is_file() {
        return Err("Only regular files can be accessed".into());
    }
    Ok((path, metadata))
}

#[cfg(unix)]
fn preserve_extended_metadata(source: &File, replacement: &File) -> Result<(), String> {
    use xattr::FileExt;

    let names = source
        .list_xattr()
        .map_err(|_| "The file's extended metadata could not be read safely".to_string())?;
    for name in names {
        let Some(value) = source
            .get_xattr(&name)
            .map_err(|_| "The file's extended metadata could not be read safely".to_string())?
        else {
            continue;
        };
        replacement.set_xattr(&name, &value).map_err(|_| {
            "The file's extended metadata could not be preserved safely".to_string()
        })?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn preserve_extended_metadata(_source: &File, _replacement: &File) -> Result<(), String> {
    Ok(())
}

fn authorized_entry(
    root: &State<'_, ActiveRoot>,
    path: &Path,
) -> Result<(PathBuf, Metadata), String> {
    let active = active_root(root)?
        .clone()
        .ok_or_else(|| "No desktop folder is authorized".to_string())?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "The selected object is unavailable".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links are not accessible".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "The selected object is unavailable".to_string())?;
    if canonical != active && !canonical.starts_with(&active) {
        return Err("Access to this object is not authorized".into());
    }
    Ok((canonical, metadata))
}

fn native_metadata(metadata: &Metadata) -> NativeMetadata {
    NativeMetadata {
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .and_then(|value| u64::try_from(value.as_millis()).ok()),
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        is_symlink: metadata.file_type().is_symlink(),
        readonly: metadata.permissions().readonly(),
    }
}

fn ensure_text_path(path: &Path) -> Result<(), String> {
    if is_text_path(path) {
        Ok(())
    } else {
        Err("Only recognized UTF-8 text files can be edited".into())
    }
}

fn is_text_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    if TEXT_FILENAMES.contains(&name.as_str()) {
        return true;
    }
    if let Some(stripped) = name.strip_prefix('.') {
        if let Some(scope) = stripped.find('.').map(|index| index + 1) {
            if TEXT_FILENAMES.contains(&&name[..scope]) {
                return true;
            }
        }
    }
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| TEXT_EXTENSIONS.contains(&extension.as_str()))
}

fn read_text_checked(path: &Path) -> Result<ReadTextResult, String> {
    let mut file = File::open(path).map_err(|_| "This file cannot be opened".to_string())?;
    ensure_open_file_still_matches(path, &file)?;
    let before_metadata = file
        .metadata()
        .map_err(|_| "This file could not be inspected".to_string())?;
    if before_metadata.len() > MAX_TEXT_WRITE_BYTES as u64 {
        return Err(format!(
            "Text files are limited to {MAX_TEXT_WRITE_BYTES} bytes"
        ));
    }
    let capacity = usize::try_from(before_metadata.len())
        .map_err(|_| "This text file is too large to read".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(MAX_TEXT_WRITE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "This text file could not be read".to_string())?;
    if bytes.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!(
            "The text file grew beyond the {MAX_TEXT_WRITE_BYTES}-byte editor limit"
        ));
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| "Editable files must contain valid UTF-8 text".to_string())?;

    // Build the displayed revision's snapshot from the same descriptor and bytes,
    // then reread that descriptor once. If an in-place writer raced this read, the
    // two hashes/metadata differ and no write baseline is issued.
    let displayed = snapshot_from_bytes(&before_metadata, &file, &bytes)?;
    let current = snapshot_from_open_file(path, &mut file)?;
    ensure_open_file_still_matches(path, &file)?;
    if displayed != current {
        return Err("The file changed while FSN was reading it. Open it again.".into());
    }
    Ok(ReadTextResult {
        bytes,
        snapshot: displayed,
    })
}

fn snapshot_from_bytes(
    metadata: &Metadata,
    file: &File,
    bytes: &[u8],
) -> Result<FileSnapshot, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    snapshot_from_digest(metadata, file, format!("{:x}", hasher.finalize()))
}

fn open_and_snapshot(path: &Path) -> Result<(File, FileSnapshot), String> {
    let mut file = File::open(path).map_err(|_| "This file cannot be opened".to_string())?;
    ensure_open_file_still_matches(path, &file)?;
    let snapshot = snapshot_from_open_file(path, &mut file)?;
    Ok((file, snapshot))
}

fn snapshot_path(path: &Path) -> Result<FileSnapshot, String> {
    let mut file = File::open(path).map_err(|_| "This file cannot be opened".to_string())?;
    ensure_open_file_still_matches(path, &file)?;
    snapshot_from_open_file(path, &mut file)
}

fn snapshot_from_open_file(_path: &Path, file: &mut File) -> Result<FileSnapshot, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "This file could not be inspected".to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be edited".into());
    }
    file.rewind()
        .map_err(|_| "This file could not be read".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; HASH_BUFFER_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "This file could not be read".to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    file.rewind()
        .map_err(|_| "This file could not be read".to_string())?;
    snapshot_from_digest(&metadata, file, format!("{:x}", hasher.finalize()))
}

fn snapshot_from_digest(
    metadata: &Metadata,
    file: &File,
    sha256: String,
) -> Result<FileSnapshot, String> {
    Ok(FileSnapshot {
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .and_then(|value| u64::try_from(value.as_millis()).ok()),
        modified_ns: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().to_string()),
        identity: file_identity(metadata),
        sha256,
        security_metadata: security_metadata_identity(metadata, file)?,
    })
}

#[cfg(unix)]
fn security_metadata_identity(metadata: &Metadata, file: &File) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    use xattr::FileExt;

    let mut hasher = Sha256::new();
    hasher.update(metadata.mode().to_le_bytes());
    hasher.update(metadata.uid().to_le_bytes());
    hasher.update(metadata.gid().to_le_bytes());
    let mut names: Vec<_> = file
        .list_xattr()
        .map_err(|_| "The file's extended metadata could not be read safely".to_string())?
        .collect();
    names.sort();
    for name in names {
        let name_bytes = name.as_encoded_bytes();
        hasher.update((name_bytes.len() as u64).to_le_bytes());
        hasher.update(name_bytes);
        if let Some(value) = file
            .get_xattr(&name)
            .map_err(|_| "The file's extended metadata could not be read safely".to_string())?
        {
            hasher.update((value.len() as u64).to_le_bytes());
            hasher.update(value);
        } else {
            hasher.update(u64::MAX.to_le_bytes());
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(windows)]
fn security_metadata_identity(metadata: &Metadata, _file: &File) -> Result<String, String> {
    use std::os::windows::fs::MetadataExt;
    Ok(format!("windows:{}", metadata.file_attributes()))
}

#[cfg(not(any(unix, windows)))]
fn security_metadata_identity(_metadata: &Metadata, _file: &File) -> Result<String, String> {
    Ok("generic".into())
}

fn ensure_open_file_still_matches(path: &Path, file: &File) -> Result<(), String> {
    let open = file
        .metadata()
        .map_err(|_| "This file could not be inspected".to_string())?;
    let path_metadata =
        fs::symlink_metadata(path).map_err(|_| "This file is unavailable".to_string())?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err("The file path changed while it was being accessed".into());
    }
    if file_identity(&open) != file_identity(&path_metadata) {
        return Err("The file was replaced while it was being accessed".into());
    }
    Ok(())
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("unix:{}:{}", metadata.dev(), metadata.ino())
}

#[cfg(windows)]
fn file_identity(metadata: &Metadata) -> String {
    use std::os::windows::fs::MetadataExt;
    format!(
        "windows:{}:{}",
        metadata.volume_serial_number().unwrap_or_default(),
        metadata.file_index().unwrap_or_default()
    )
}

#[cfg(not(any(unix, windows)))]
fn file_identity(metadata: &Metadata) -> String {
    format!("generic:{}", metadata.len())
}

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
            require_active_root,
            clear_active_root,
            read_dir_native,
            stat_native,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "fsn-atomic-write-{name}-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn stale_snapshot_returns_conflict_without_changing_file() {
        let directory = test_dir("conflict");
        let path = directory.join("notes.txt");
        fs::write(&path, b"first").unwrap();
        let expected = snapshot_path(&path).unwrap();
        fs::write(&path, b"newer").unwrap();

        let result = write_text_checked(&path, b"editor", &expected, || Ok(())).unwrap();
        assert!(matches!(result, WriteTextResult::Conflict { .. }));
        assert_eq!(fs::read(&path).unwrap(), b"newer");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failure_before_commit_preserves_original_file() {
        let directory = test_dir("failed-commit");
        let path = directory.join("notes.txt");
        fs::write(&path, b"original").unwrap();
        let expected = snapshot_path(&path).unwrap();

        let result = write_text_checked(&path, b"replacement", &expected, || {
            Err(io::Error::other("simulated pre-commit failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn successful_write_returns_new_snapshot() {
        let directory = test_dir("success");
        let path = directory.join("notes.txt");
        fs::write(&path, b"old").unwrap();
        let expected = snapshot_path(&path).unwrap();

        let result = write_text_checked(&path, b"replacement", &expected, || Ok(())).unwrap();
        let WriteTextResult::Saved { snapshot } = result else {
            panic!("expected saved result");
        };
        assert_eq!(snapshot.size, 11);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn text_authorization_covers_requested_and_named_formats() {
        for name in [
            "notes.md",
            "component.mdx",
            "config.yml",
            "settings.yaml",
            ".env.local",
            "Cargo.lock",
            "Makefile",
        ] {
            assert!(is_text_path(Path::new(name)), "expected text: {name}");
        }
        for name in [
            "archive.zip",
            "database.sqlite",
            "program.exe",
            "unknown.dat",
        ] {
            assert!(!is_text_path(Path::new(name)), "expected non-text: {name}");
        }
    }

    #[test]
    fn text_read_returns_bytes_and_snapshot_from_the_same_revision() {
        let directory = test_dir("text-read");
        let path = directory.join("notes.md");
        fs::write(&path, b"# stable\n").unwrap();

        let result = read_text_checked(&path).unwrap();
        assert_eq!(result.bytes, b"# stable\n");
        assert_eq!(result.snapshot, snapshot_path(&path).unwrap());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn text_read_rejects_invalid_utf8() {
        let directory = test_dir("invalid-utf8");
        let path = directory.join("notes.md");
        fs::write(&path, [0xff, 0xfe]).unwrap();

        assert!(read_text_checked(&path).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn successful_write_preserves_unix_mode() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = test_dir("mode");
        let path = directory.join("script.txt");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let expected = snapshot_path(&path).unwrap();

        write_text_checked(&path, b"replacement", &expected, || Ok(())).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o640);
        fs::remove_dir_all(directory).unwrap();
    }
}
