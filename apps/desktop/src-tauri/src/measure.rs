//! Totals for the disk-usage lens: how many bytes and files sit beneath a directory.
//!
//! The walk starts from a directory handle that `ActiveRoot::directory` has already
//! validated against the grant, and only ever descends through handles opened relative
//! to it, so it cannot leave the root however the tree is shaped. Symbolic links are
//! neither counted nor followed: a link to `/` inside a project folder would otherwise
//! make the project look as large as the disk, and following one is how a walk escapes
//! the folder it was given. Sizes are apparent sizes, the way a listing reports them,
//! not allocated blocks.

use cap_std::fs::Dir;
use serde::Serialize;

/// Entries visited before the walk gives up and reports what it has as a lower bound.
/// Generous, because this runs natively and off the main thread; bounded, because a
/// home directory can hold millions and nobody is waiting that long for a folder height.
pub const MAX_MEASURED_ENTRIES: u64 = 400_000;

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryUsage {
    pub bytes: u64,
    pub files: u64,
    pub directories: u64,
    /// Latest modification time among the files counted, in Unix milliseconds.
    pub newest: Option<u64>,
    /// False when the cap was reached or a directory beneath could not be read.
    pub complete: bool,
}

/// Walks everything under `dir` depth-first with an explicit stack, so a deep tree
/// cannot overflow the thread's own stack.
pub fn measure(dir: Dir, limit: u64) -> DirectoryUsage {
    let mut usage = DirectoryUsage {
        complete: true,
        ..Default::default()
    };
    let mut visited = 0u64;
    let mut pending = vec![dir];
    while let Some(current) = pending.pop() {
        let Ok(entries) = current.entries() else {
            usage.complete = false;
            continue;
        };
        for entry in entries {
            visited += 1;
            if visited > limit {
                usage.complete = false;
                return usage;
            }
            let Ok(entry) = entry else {
                usage.complete = false;
                continue;
            };
            // `file_type` describes the entry itself, so a symlink reports as one here
            // rather than as whatever it points at.
            let Ok(file_type) = entry.file_type() else {
                usage.complete = false;
                continue;
            };
            if file_type.is_dir() {
                usage.directories += 1;
                // Opened through the entry, relative to its parent's handle: should the
                // directory be swapped for a link after the check above, cap-std's
                // sandbox still refuses anything that would resolve outside the parent.
                match entry.open_dir() {
                    Ok(child) => pending.push(child),
                    Err(_) => usage.complete = false,
                }
            } else if file_type.is_file() {
                let Ok(metadata) = entry.metadata() else {
                    usage.complete = false;
                    continue;
                };
                usage.files += 1;
                usage.bytes = usage.bytes.saturating_add(metadata.len());
                let modified = metadata
                    .modified()
                    .ok()
                    .map(cap_std::time::SystemTime::into_std)
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|since| u64::try_from(since.as_millis()).ok());
                if let Some(modified) = modified {
                    usage.newest =
                        Some(usage.newest.map_or(modified, |newest| newest.max(modified)));
                }
            }
        }
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;

    fn fixture(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "fsn-measure-{name}-{}-{}",
            std::process::id(),
            std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(base.join("root/nested/deeper")).unwrap();
        std::fs::write(base.join("root/a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(base.join("root/nested/b.bin"), vec![0u8; 20]).unwrap();
        std::fs::write(base.join("root/nested/deeper/c.bin"), vec![0u8; 3]).unwrap();
        base
    }

    fn open(path: &std::path::Path) -> Dir {
        Dir::open_ambient_dir(path, ambient_authority()).unwrap()
    }

    #[test]
    fn totals_everything_beneath_a_directory() {
        let base = fixture("totals");
        let usage = measure(open(&base.join("root")), MAX_MEASURED_ENTRIES);
        assert_eq!(usage.bytes, 123);
        assert_eq!(usage.files, 3);
        assert_eq!(usage.directories, 2);
        assert!(usage.complete);
        assert!(usage.newest.is_some());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stops_at_the_cap_and_says_the_total_is_partial() {
        let base = fixture("cap");
        let usage = measure(open(&base.join("root")), 2);
        assert!(!usage.complete);
        assert!(usage.files < 3);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn neither_counts_nor_follows_symbolic_links() {
        use std::os::unix::fs::symlink;
        let base = fixture("links");
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::fs::write(base.join("outside/huge.bin"), vec![0u8; 5000]).unwrap();
        symlink(base.join("outside"), base.join("root/escape")).unwrap();
        symlink(base.join("outside/huge.bin"), base.join("root/huge-link")).unwrap();
        let usage = measure(open(&base.join("root")), MAX_MEASURED_ENTRIES);
        assert_eq!(usage.bytes, 123);
        assert_eq!(usage.files, 3);
        std::fs::remove_dir_all(base).unwrap();
    }
}
