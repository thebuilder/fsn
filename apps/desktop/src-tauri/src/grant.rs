use std::{
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use cap_std::{ambient_authority, fs::Dir};

pub struct RootGrant {
    dir: Dir,
    display_path: PathBuf,
}

#[derive(Default)]
pub struct ActiveRoot(Mutex<Option<RootGrant>>);

impl ActiveRoot {
    pub fn replace(&self, selected: &Path) -> Result<PathBuf, String> {
        let metadata = std::fs::symlink_metadata(selected)
            .map_err(|_| "The selected folder is unavailable".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("The selected path is not a regular directory".into());
        }
        let display_path = selected
            .canonicalize()
            .map_err(|_| "The selected folder is unavailable".to_string())?;
        let dir = Dir::open_ambient_dir(&display_path, ambient_authority())
            .map_err(|_| "The selected folder cannot be opened".to_string())?;
        *self.lock()? = Some(RootGrant {
            dir,
            display_path: display_path.clone(),
        });
        Ok(display_path)
    }

    pub fn clear(&self) -> Result<(), String> {
        *self.lock()? = None;
        Ok(())
    }

    pub fn access<T>(
        &self,
        path: &Path,
        operation: impl FnOnce(&Dir, &Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.lock()?;
        let grant = guard
            .as_ref()
            .ok_or_else(|| "No desktop folder is authorized".to_string())?;
        let relative = relative_path(&grant.display_path, path)?;
        operation(&grant.dir, relative)
    }

    pub fn root<T>(
        &self,
        operation: impl FnOnce(&Dir, &Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.lock()?;
        let grant = guard
            .as_ref()
            .ok_or_else(|| "No desktop folder is authorized".to_string())?;
        operation(&grant.dir, &grant.display_path)
    }

    pub fn open_file(&self, path: &Path) -> Result<std::fs::File, String> {
        self.access(path, |dir, relative| {
            let metadata = dir
                .symlink_metadata(relative)
                .map_err(|_| "The selected object is unavailable".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Only regular files can be accessed".into());
            }
            dir.open(relative)
                .map(cap_std::fs::File::into_std)
                .map_err(|_| "This file cannot be opened".to_string())
        })
    }

    pub fn directory(&self, path: &Path) -> Result<(Dir, PathBuf), String> {
        self.access(path, |dir, relative| {
            let metadata = dir
                .symlink_metadata(relative)
                .map_err(|_| "The selected object is unavailable".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Only regular directories can be traversed".into());
            }
            dir.open_dir(relative)
                .map(|opened| (opened, path.to_path_buf()))
                .map_err(|_| "This directory cannot be read".to_string())
        })
    }

    pub fn scoped(&self, path: &Path) -> Result<(Dir, PathBuf), String> {
        let guard = self.lock()?;
        let grant = guard
            .as_ref()
            .ok_or_else(|| "No desktop folder is authorized".to_string())?;
        let relative = relative_path(&grant.display_path, path)?.to_path_buf();
        let dir = grant
            .dir
            .try_clone()
            .map_err(|_| "The desktop filesystem session is unavailable".to_string())?;
        Ok((dir, relative))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<RootGrant>>, String> {
        self.0
            .lock()
            .map_err(|_| "The desktop filesystem session is unavailable".to_string())
    }
}

fn relative_path<'a>(root: &Path, requested: &'a Path) -> Result<&'a Path, String> {
    let relative = requested
        .strip_prefix(root)
        .map_err(|_| "Access to this object is not authorized".to_string())?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("Access to this object is not authorized".into());
    }
    Ok(relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_escape_is_rejected() {
        let root = Path::new("/tmp/granted");
        assert!(relative_path(root, Path::new("/tmp/granted/file.txt")).is_ok());
        assert!(relative_path(root, Path::new("/tmp/granted/../secret.txt")).is_err());
        assert!(relative_path(root, Path::new("/tmp/other/file.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_blocked_by_capability() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("fsn-grant-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), b"secret").unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        let grant = ActiveRoot::default();
        grant.replace(&root).unwrap();
        let result = grant.access(&root.join("escape/secret"), |dir, relative| {
            dir.open(relative)
                .map(|_| ())
                .map_err(|error| error.to_string())
        });
        assert!(result.is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
