use std::path::Path;

const BLOCKED_OPEN: &[&str] = &[
    // Direct execution / installers
    "app",
    "bat",
    "bin",
    "cmd",
    "com",
    "command",
    "cpl",
    "dat",
    "desktop",
    "dll",
    "dylib",
    "exe",
    "hta",
    "lnk",
    "msi",
    "pkg",
    "ps1",
    "reg",
    "scr",
    "sh",
    "so",
    "vbs",
    // Archives that execute or mount as a volume
    "dmg",
    "img",
    "iso",
    "jar",
    "jnlp",
    "smi",
    "sparsebundle",
    "sparseimage",
    // macOS automation & location files
    "applescript",
    "fileloc",
    "ftploc",
    "inetloc",
    "scpt",
    "scptd",
    "terminal",
    "webloc",
    "workflow",
    // Windows script host & shell handlers. `js` is deliberately blocked here even though it is
    // an editable text type: on Windows the shell executes `.js` via WSH. Text files always have
    // a viewer, so the auto-open path never routes through this list for them anyway — this only
    // guards the explicit native-open action.
    "application",
    "appref-ms",
    "chm",
    "gadget",
    "js",
    "jse",
    "msc",
    "msp",
    "mst",
    "pif",
    "scf",
    "sct",
    "shb",
    "shs",
    "url",
    "vbe",
    "wsf",
    "wsh",
    // PowerShell family beyond ps1
    "ps1xml",
    "psc1",
    "psd1",
    "psm1",
    // Installer/package formats that run on open
    "apk",
    "appimage",
    "appx",
    "msix",
    "msixbundle",
    "run",
    // Shells beyond sh
    "bash",
    "csh",
    "fish",
    "ksh",
    "zsh",
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

pub fn can_edit_text(path: &Path) -> bool {
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

pub fn can_open_native(path: &Path, executable: bool) -> bool {
    !executable
        && !path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .is_some_and(|extension| BLOCKED_OPEN.contains(&extension.as_str()))
}

pub fn can_open_bundle(path: &Path) -> bool {
    cfg!(target_os = "macos")
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn covers_requested_text_formats() {
        for name in [
            "notes.md",
            "component.mdx",
            "config.yml",
            "settings.yaml",
            ".env.local",
            "Cargo.lock",
            "Makefile",
        ] {
            assert!(can_edit_text(Path::new(name)), "expected text: {name}");
        }
        for name in [
            "archive.zip",
            "database.sqlite",
            "program.exe",
            "unknown.dat",
        ] {
            assert!(!can_edit_text(Path::new(name)), "expected non-text: {name}");
        }
    }

    #[test]
    fn widened_deny_list_blocks_native_open_of_execution_families() {
        for name in [
            "report.jar",
            "backup.dmg",
            "link.webloc",
            "script.wsf",
            "page.url",
            "tool.appimage",
        ] {
            assert!(
                !can_open_native(Path::new(name), false),
                "expected blocked: {name}"
            );
        }
        for name in ["photo.jpg", "notes.txt", "deck.key"] {
            assert!(
                can_open_native(Path::new(name), false),
                "expected allowed: {name}"
            );
        }
    }

    #[test]
    fn only_macos_app_directories_are_native_bundles() {
        assert_eq!(
            can_open_bundle(Path::new("Example.app")),
            cfg!(target_os = "macos")
        );
        assert!(!can_open_bundle(Path::new("Example.app/Contents")));
        assert!(!can_open_bundle(Path::new("Example.bundle")));
    }
}
