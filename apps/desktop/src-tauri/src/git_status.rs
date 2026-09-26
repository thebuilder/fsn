//! Git status for the colour lens, read without running anything the repository asks for.
//!
//! Opening a folder in FSN must never execute code it brought with it, and a git
//! repository is full of places that name a program to run: `core.fsmonitor` is a
//! command git starts on every status, `filter.<driver>.clean` is a command it pipes
//! file contents through when it needs to compare them against the index, and hooks sit
//! in the `.git` directory waiting to be called. The `git` binary honours all of these
//! from the repository's own `.git/config`, and while `-c core.fsmonitor=false` and a
//! throwaway hooks path cover the first and the last, there is no switch that turns off
//! every filter driver: they are keyed by names the repository itself chooses.
//!
//! So this reads the repository with `gix`, in-process, rather than shelling out. It has
//! no fsmonitor integration and never runs hooks for a status, and it is opened at
//! *reduced* trust, which is gitoxide's own model for a repository whose configuration
//! should not be allowed to launch anything: sections from the repository's own config
//! are skipped wherever a value would name a program, filter drivers included. Isolated
//! permissions keep the user's global and system configuration and the environment out
//! of it as well, so the answer depends on nothing but the folder and the index on disk.
//! As a last line of defence the filter pipeline is checked for drivers before the
//! status runs, and a repository that somehow still has one is refused outright.
//!
//! Only the Rust-owned active root is ever used as a starting point; nothing arrives
//! from the webview. The repository it belongs to may begin above it — the root can be
//! a subfolder of a work tree — so discovery walks upwards, but everything reported is
//! scoped back down to paths inside the root before it leaves this module.

use std::{collections::BTreeMap, path::Path};

use serde::Serialize;

/// Enough to colour any directory a person could reasonably walk through; beyond it the
/// report says it was cut short, and the lens shows what it has.
pub const MAX_GIT_ENTRIES: usize = 20_000;
/// A ceiling on raw status items examined, for work trees so broken that nearly every
/// file reports a change: past it the walk stops rather than holding a thread for minutes.
const MAX_SCANNED_ITEMS: usize = 200_000;

/// One path's standing, ordered weakest to strongest so a path reported twice (staged
/// and then changed again in the work tree) keeps whichever says the most.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitState {
    Ignored,
    Untracked,
    Added,
    Deleted,
    Modified,
    Conflicted,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEntry {
    /// Relative to the active root, `/`-separated. Empty when the state covers the
    /// whole root, as it does when the root sits inside an untracked or ignored folder.
    pub path: String,
    pub state: GitState,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusReport {
    pub entries: Vec<GitEntry>,
    /// True when there were more changes than `MAX_GIT_ENTRIES`, so the rest read as clean.
    pub truncated: bool,
}

/// Narrows repository-relative entries to the ones under `prefix` (the active root,
/// relative to the work tree, empty when they are the same place) and re-expresses
/// them relative to it.
///
/// An entry for a directory *above* the root can only be a collapsed untracked or
/// ignored folder that the root lives in, and then its state is the state of the whole
/// root, so it is kept as the empty path. Entries are merged by strength and sorted, so
/// the same repository always produces the same report, and a cut-off report always
/// cuts off the same entries.
pub fn scope_to_root(
    entries: impl IntoIterator<Item = (String, GitState)>,
    prefix: &str,
    limit: usize,
) -> GitStatusReport {
    let prefix = prefix.trim_matches('/');
    let mut merged = BTreeMap::<String, GitState>::new();
    for (path, state) in entries {
        let path = path.trim_end_matches('/');
        let relative = if prefix.is_empty() {
            path
        } else if path == prefix {
            ""
        } else if let Some(rest) = path
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('/'))
        {
            rest
        } else if prefix
            .strip_prefix(path)
            .is_some_and(|rest| rest.starts_with('/'))
        {
            ""
        } else {
            continue;
        };
        merged
            .entry(relative.to_string())
            .and_modify(|existing| *existing = (*existing).max(state))
            .or_insert(state);
    }
    let truncated = merged.len() > limit;
    GitStatusReport {
        entries: merged
            .into_iter()
            .take(limit)
            .map(|(path, state)| GitEntry { path, state })
            .collect(),
        truncated,
    }
}

/// The repository-relative path from the work tree to `root`, or `None` when the root is
/// not inside it or a component cannot be expressed as UTF-8 to match status paths with.
fn root_prefix(work_tree: &Path, root: &Path) -> Option<String> {
    let relative = root.strip_prefix(work_tree).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_str()?),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn open_options() -> gix::open::Options {
    gix::open::Options::isolated()
        .with(gix::sec::Trust::Reduced)
        .filter_config_section(gix::config::section::is_trusted)
}

/// Reads the status of the work tree `root` belongs to, scoped to `root`. `Ok(None)`
/// means there is no work tree to report on: not a repository, a bare one, or a root
/// that cannot be placed inside it.
pub fn read_status(root: &Path) -> Result<Option<GitStatusReport>, String> {
    let discovery = gix::discover::upwards::Options {
        // Assumed rather than computed from ownership: a folder the user owns is exactly
        // as untrusted as one they do not, when it arrived in a download.
        trust: gix::discover::upwards::TrustPolicy::Assume(gix::sec::Trust::Reduced),
        dot_git_only: true,
        ..Default::default()
    };
    let Ok(repo) = gix::discover_opts(root, discovery, open_options()) else {
        return Ok(None);
    };
    let Some(work_tree) = repo.workdir() else {
        return Ok(None);
    };
    let Ok(work_tree) = work_tree.canonicalize() else {
        return Ok(None);
    };
    let Some(prefix) = root_prefix(&work_tree, root) else {
        return Ok(None);
    };

    let drivers = gix::filter::Pipeline::options(&repo)
        .map_err(|_| "The repository configuration could not be read".to_string())?
        .drivers;
    if !drivers.is_empty() {
        return Err("This repository configures filter programs, which FSN will not run".into());
    }

    // The literal magic keeps a folder called `[draft]` from being read as a glob.
    let patterns: Vec<gix::bstr::BString> = if prefix.is_empty() {
        Vec::new()
    } else {
        vec![format!(":(literal){prefix}").into()]
    };
    let unreadable = |_| "The repository status could not be read".to_string();
    let items = repo
        .status(gix::progress::Discard)
        .map_err(unreadable)?
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        .index_worktree_submodules(gix::status::Submodule::Given {
            ignore: gix::submodule::config::Ignore::All,
            check_dirty: false,
        })
        .index_worktree_rewrites(None)
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
        .dirwalk_options(|options| {
            options.emit_ignored(Some(gix::dir::walk::EmissionMode::CollapseDirectory))
        })
        .into_iter(patterns)
        .map_err(unreadable)?;

    let mut collected = Vec::new();
    for item in items.take(MAX_SCANNED_ITEMS) {
        let Ok(item) = item else { continue };
        if let Some(state) = classify(&item) {
            if let Ok(path) = std::str::from_utf8(item.location()) {
                collected.push((path.to_string(), state));
            }
        }
    }
    Ok(Some(scope_to_root(collected, &prefix, MAX_GIT_ENTRIES)))
}

/// What one status item means for the lens. Bookkeeping items that only say the index's
/// cached stat data is stale, and tracked or pruned walk entries, mean nothing.
fn classify(item: &gix::status::Item) -> Option<GitState> {
    use gix::status::{
        index_worktree::Item as Worktree,
        plumbing::index_as_worktree::{Change, EntryStatus},
    };
    match item {
        gix::status::Item::IndexWorktree(Worktree::Modification { status, .. }) => match status {
            EntryStatus::Conflict { .. } => Some(GitState::Conflicted),
            EntryStatus::Change(Change::Removed) => Some(GitState::Deleted),
            EntryStatus::Change(_) => Some(GitState::Modified),
            EntryStatus::IntentToAdd => Some(GitState::Added),
            EntryStatus::NeedsUpdate(_) => None,
        },
        gix::status::Item::IndexWorktree(Worktree::DirectoryContents { entry, .. }) => {
            match entry.status {
                gix::dir::entry::Status::Untracked => Some(GitState::Untracked),
                gix::dir::entry::Status::Ignored(_) => Some(GitState::Ignored),
                gix::dir::entry::Status::Tracked | gix::dir::entry::Status::Pruned => None,
            }
        }
        gix::status::Item::IndexWorktree(Worktree::Rewrite { .. }) => Some(GitState::Added),
        gix::status::Item::TreeIndex(change) => Some(match change {
            gix::diff::index::ChangeRef::Addition { .. } => GitState::Added,
            gix::diff::index::ChangeRef::Deletion { .. } => GitState::Deleted,
            gix::diff::index::ChangeRef::Modification { .. } => GitState::Modified,
            gix::diff::index::ChangeRef::Rewrite { .. } => GitState::Added,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn entries(pairs: &[(&str, GitState)]) -> Vec<(String, GitState)> {
        pairs
            .iter()
            .map(|(path, state)| (path.to_string(), *state))
            .collect()
    }

    #[test]
    fn a_root_at_the_work_tree_keeps_every_path() {
        let report = scope_to_root(
            entries(&[
                ("src/main.rs", GitState::Modified),
                ("notes/", GitState::Untracked),
            ]),
            "",
            10,
        );
        assert_eq!(
            report.entries,
            vec![
                GitEntry {
                    path: "notes".into(),
                    state: GitState::Untracked
                },
                GitEntry {
                    path: "src/main.rs".into(),
                    state: GitState::Modified
                },
            ]
        );
        assert!(!report.truncated);
    }

    #[test]
    fn a_root_inside_the_work_tree_sees_only_its_own_paths() {
        let report = scope_to_root(
            entries(&[
                ("app/src/main.rs", GitState::Modified),
                ("app-other/file", GitState::Modified),
                ("docs/readme.md", GitState::Added),
            ]),
            "app",
            10,
        );
        assert_eq!(
            report.entries,
            vec![GitEntry {
                path: "src/main.rs".into(),
                state: GitState::Modified
            }]
        );
    }

    #[test]
    fn a_collapsed_folder_around_the_root_covers_all_of_it() {
        let report = scope_to_root(entries(&[("build", GitState::Ignored)]), "build/out", 10);
        assert_eq!(
            report.entries,
            vec![GitEntry {
                path: String::new(),
                state: GitState::Ignored
            }]
        );
    }

    #[test]
    fn a_path_reported_twice_keeps_the_stronger_state() {
        let report = scope_to_root(
            entries(&[("a.txt", GitState::Added), ("a.txt", GitState::Modified)]),
            "",
            10,
        );
        assert_eq!(report.entries[0].state, GitState::Modified);
        assert_eq!(report.entries.len(), 1);
    }

    #[test]
    fn a_long_report_is_cut_short_and_says_so() {
        let many: Vec<_> = (0..5)
            .map(|index| (format!("file-{index}"), GitState::Untracked))
            .collect();
        let report = scope_to_root(many, "", 3);
        assert!(report.truncated);
        assert_eq!(report.entries.len(), 3);
        assert_eq!(report.entries[0].path, "file-0");
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args([
                "-c",
                "user.name=FSN",
                "-c",
                "user.email=fsn@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// Builds a repository that tries every trick in its own config to get a program run
    /// the moment its status is read, then reads it. The fixture needs the `git` binary
    /// to build; without one there is nothing to test against, so the test stands down.
    #[test]
    fn reads_status_without_running_anything_the_repository_configures() {
        let base = std::env::temp_dir().join(format!(
            "fsn-git-status-{}-{}",
            std::process::id(),
            std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(base.join("repo/src")).unwrap();
        let base = base.canonicalize().unwrap();
        let repo = base.join("repo");
        if !git(&repo, &["init", "-q"]) {
            std::fs::remove_dir_all(base).unwrap();
            return;
        }
        std::fs::write(repo.join("src/kept.txt"), b"kept").unwrap();
        std::fs::write(repo.join("src/changed.txt"), b"before").unwrap();
        std::fs::write(repo.join("gone.txt"), b"gone").unwrap();
        std::fs::write(repo.join(".gitignore"), b"build/\n").unwrap();
        assert!(git(&repo, &["add", "."]));
        assert!(git(&repo, &["commit", "-q", "-m", "initial"]));

        std::fs::write(repo.join("src/staged.txt"), b"staged").unwrap();
        assert!(git(&repo, &["add", "src/staged.txt"]));
        // Same length, different bytes: a status can only tell by reading the content,
        // which is exactly when git would pipe it through a clean filter.
        std::fs::write(repo.join("src/changed.txt"), b"after!").unwrap();
        std::fs::remove_file(repo.join("gone.txt")).unwrap();
        std::fs::create_dir_all(repo.join("build")).unwrap();
        std::fs::write(repo.join("build/out.bin"), b"out").unwrap();
        std::fs::create_dir_all(repo.join("fresh")).unwrap();
        std::fs::write(repo.join("fresh/new.txt"), b"new").unwrap();

        // Installed last, so building the fixture never trips them itself.
        let marker = |name: &str| base.join(name);
        let config = format!(
            "\n[core]\n\tfsmonitor = touch {fsmonitor}\n\thooksPath = hooks\n[filter \"evil\"]\n\tclean = touch {clean} && cat\n\tprocess = touch {process}\n\trequired = true\n",
            fsmonitor = marker("fsmonitor-ran").display(),
            clean = marker("clean-ran").display(),
            process = marker("process-ran").display(),
        );
        let mut existing = std::fs::read_to_string(repo.join(".git/config")).unwrap();
        existing.push_str(&config);
        std::fs::write(repo.join(".git/config"), existing).unwrap();
        std::fs::write(repo.join(".gitattributes"), b"* filter=evil\n").unwrap();

        let report = read_status(&repo).unwrap().expect("a work tree");
        let state_of = |path: &str| {
            report
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .map(|entry| entry.state)
        };
        assert_eq!(state_of("src/changed.txt"), Some(GitState::Modified));
        assert_eq!(state_of("src/staged.txt"), Some(GitState::Added));
        assert_eq!(state_of("gone.txt"), Some(GitState::Deleted));
        assert_eq!(state_of("fresh"), Some(GitState::Untracked));
        assert_eq!(state_of("build"), Some(GitState::Ignored));
        assert_eq!(state_of("src/kept.txt"), None);

        // Scoped to a subfolder, the same repository reports only what is inside it.
        let scoped = read_status(&repo.join("src"))
            .unwrap()
            .expect("a work tree");
        assert!(scoped
            .entries
            .iter()
            .all(|entry| !entry.path.contains("gone") && !entry.path.starts_with("src/")));
        assert!(scoped
            .entries
            .iter()
            .any(|entry| entry.path == "changed.txt"));

        for name in ["fsmonitor-ran", "clean-ran", "process-ran"] {
            assert!(!marker(name).exists(), "{name} was executed");
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_folder_outside_any_repository_has_no_status() {
        let base = std::env::temp_dir().join(format!(
            "fsn-git-none-{}-{}",
            std::process::id(),
            std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        // The temp directory could itself sit inside someone's work tree; only assert
        // when discovery genuinely finds nothing above it.
        if gix::discover(&base).is_err() {
            assert_eq!(read_status(&base).unwrap(), None);
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
