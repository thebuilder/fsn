use std::{
    fs::{File, Metadata},
    io::{Read, Seek, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const HASH_BUFFER_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_BYTES: usize = 2_000_000;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub size: u64,
    pub modified: Option<u64>,
    pub modified_ns: Option<String>,
    pub identity: String,
    pub sha256: String,
    pub security_metadata: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum WriteTextResult {
    Saved { snapshot: FileSnapshot },
    Conflict { actual: FileSnapshot },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextResult {
    pub bytes: Vec<u8>,
    pub snapshot: FileSnapshot,
    pub is_utf8: bool,
}

pub fn read_text(mut file: File) -> Result<ReadTextResult, String> {
    let metadata = regular_metadata(&file)?;
    if metadata.len() > MAX_TEXT_BYTES as u64 {
        return Err(limit_error());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "This text file could not be read".to_string())?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(limit_error());
    }
    // Strict UTF-8 is only required to arm a destructive save; a read should
    // still show legacy/malformed text rather than fail outright.
    let is_utf8 = std::str::from_utf8(&bytes).is_ok();
    let displayed = snapshot_from_bytes(&metadata, &file, &bytes)?;
    let current = snapshot_file(&mut file)?;
    if displayed != current {
        return Err("The file changed while FSN was reading it. Open it again.".into());
    }
    Ok(ReadTextResult {
        bytes,
        snapshot: displayed,
        is_utf8,
    })
}

pub fn write_text(
    dir: &Dir,
    relative: &Path,
    bytes: &[u8],
    expected: &FileSnapshot,
) -> Result<WriteTextResult, String> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(limit_error());
    }
    let parent_path = relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = relative
        .file_name()
        .ok_or_else(|| "This file cannot be edited".to_string())?;
    let parent = dir
        .open_dir(parent_path)
        .map_err(|_| "This file cannot be opened".to_string())?;
    let mut source = parent
        .open(name)
        .map(cap_std::fs::File::into_std)
        .map_err(|_| "This file cannot be opened".to_string())?;
    if source
        .metadata()
        .map_err(|_| "This file could not be inspected".to_string())?
        .permissions()
        .readonly()
    {
        return Err("This file is read-only".into());
    }
    let actual = snapshot_file(&mut source)?;
    if &actual != expected {
        return Ok(WriteTextResult::Conflict { actual });
    }

    let temp_name = format!(
        ".fsn-save-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut replacement = parent
        .open_with(&temp_name, &options)
        .map(cap_std::fs::File::into_std)
        .map_err(|_| "A replacement file could not be prepared".to_string())?;
    let result = (|| {
        replacement
            .write_all(bytes)
            .and_then(|_| replacement.flush())
            .map_err(|_| "The edited file could not be flushed safely".to_string())?;
        preserve_metadata(&source, &replacement)?;
        replacement
            .sync_all()
            .map_err(|_| "The edited file could not be flushed safely".to_string())?;
        let pre_commit = snapshot_file(&mut source)?;
        let mut current_file = parent
            .open(name)
            .map(cap_std::fs::File::into_std)
            .map_err(|_| "This file cannot be opened".to_string())?;
        let current = snapshot_file(&mut current_file)?;
        if pre_commit != actual || current != actual {
            return Ok(WriteTextResult::Conflict { actual: current });
        }
        drop(replacement);
        parent
            .rename(&temp_name, &parent, name)
            .map_err(|_| "The edited file could not be committed safely".to_string())?;
        let mut saved_file = parent
            .open(name)
            .map(cap_std::fs::File::into_std)
            .map_err(|_| "The saved file could not be opened".to_string())?;
        Ok(WriteTextResult::Saved {
            snapshot: snapshot_file(&mut saved_file)?,
        })
    })();
    if result.is_err() || matches!(result, Ok(WriteTextResult::Conflict { .. })) {
        let _ = parent.remove_file(&temp_name);
    }
    result
}

pub fn snapshot_file(file: &mut File) -> Result<FileSnapshot, String> {
    let metadata = regular_metadata(file)?;
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

fn regular_metadata(file: &File) -> Result<Metadata, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "This file could not be inspected".to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be edited".into());
    }
    Ok(metadata)
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

fn snapshot_from_digest(
    metadata: &Metadata,
    file: &File,
    sha256: String,
) -> Result<FileSnapshot, String> {
    let duration = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok());
    Ok(FileSnapshot {
        size: metadata.len(),
        modified: duration.and_then(|value| u64::try_from(value.as_millis()).ok()),
        modified_ns: duration.map(|value| value.as_nanos().to_string()),
        identity: file_identity(metadata),
        sha256,
        security_metadata: security_metadata_identity(metadata, file)?,
    })
}

#[cfg(unix)]
fn preserve_metadata(source: &File, replacement: &File) -> Result<(), String> {
    use xattr::FileExt;
    replacement
        .set_permissions(
            source
                .metadata()
                .map_err(|_| "File metadata could not be read".to_string())?
                .permissions(),
        )
        .map_err(|_| "File permissions could not be preserved".to_string())?;
    for name in source
        .list_xattr()
        .map_err(|_| "Extended metadata could not be read".to_string())?
    {
        if let Some(value) = source
            .get_xattr(&name)
            .map_err(|_| "Extended metadata could not be read".to_string())?
        {
            replacement
                .set_xattr(&name, &value)
                .map_err(|_| "Extended metadata could not be preserved".to_string())?;
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn preserve_metadata(source: &File, replacement: &File) -> Result<(), String> {
    replacement
        .set_permissions(
            source
                .metadata()
                .map_err(|_| "File metadata could not be read".to_string())?
                .permissions(),
        )
        .map_err(|_| "File permissions could not be preserved".to_string())
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
        .map_err(|_| "Extended metadata could not be read".to_string())?
        .collect();
    names.sort();
    for name in names {
        hasher.update(name.as_encoded_bytes());
        if let Some(value) = file
            .get_xattr(&name)
            .map_err(|_| "Extended metadata could not be read".to_string())?
        {
            hasher.update(value);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}
#[cfg(windows)]
fn security_metadata_identity(metadata: &Metadata, _: &File) -> Result<String, String> {
    use std::os::windows::fs::MetadataExt;
    Ok(format!("windows:{}", metadata.file_attributes()))
}
#[cfg(not(any(unix, windows)))]
fn security_metadata_identity(_: &Metadata, _: &File) -> Result<String, String> {
    Ok("generic".into())
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
fn limit_error() -> String {
    format!("Text files are limited to {MAX_TEXT_BYTES} bytes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;

    fn fixture(name: &str, contents: &[u8]) -> (std::path::PathBuf, Dir) {
        let path = std::env::temp_dir().join(format!(
            "fsn-text-edit-{name}-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("notes.txt"), contents).unwrap();
        let dir = Dir::open_ambient_dir(&path, ambient_authority()).unwrap();
        (path, dir)
    }

    fn snapshot(dir: &Dir) -> FileSnapshot {
        let mut file = dir.open("notes.txt").unwrap().into_std();
        snapshot_file(&mut file).unwrap()
    }

    #[test]
    fn stale_snapshot_does_not_replace_file() {
        let (path, dir) = fixture("conflict", b"first");
        let expected = snapshot(&dir);
        dir.write("notes.txt", b"newer").unwrap();
        let result = write_text(&dir, Path::new("notes.txt"), b"editor", &expected).unwrap();
        assert!(matches!(result, WriteTextResult::Conflict { .. }));
        assert_eq!(std::fs::read(path.join("notes.txt")).unwrap(), b"newer");
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn successful_write_returns_matching_snapshot() {
        let (path, dir) = fixture("success", b"old");
        let expected = snapshot(&dir);
        let result = write_text(&dir, Path::new("notes.txt"), b"replacement", &expected).unwrap();
        let WriteTextResult::Saved { snapshot: saved } = result else {
            panic!("expected save")
        };
        assert_eq!(saved, snapshot(&dir));
        assert_eq!(
            std::fs::read(path.join("notes.txt")).unwrap(),
            b"replacement"
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn text_read_flags_invalid_utf8() {
        let (path, dir) = fixture("invalid", &[0xff, 0xfe]);
        let file = dir.open("notes.txt").unwrap().into_std();
        let result = read_text(file).unwrap();
        assert!(!result.is_utf8);
        assert_eq!(result.bytes, vec![0xff, 0xfe]);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn text_read_flags_valid_utf8() {
        let (path, dir) = fixture("valid", b"hello world");
        let file = dir.open("notes.txt").unwrap().into_std();
        let result = read_text(file).unwrap();
        assert!(result.is_utf8);
        assert_eq!(result.bytes, b"hello world");
        std::fs::remove_dir_all(path).unwrap();
    }
}
