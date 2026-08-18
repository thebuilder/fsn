<p align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" alt="FSN icon" width="128" height="128" />
</p>

# FSN: File System Navigator

A web and desktop tribute to SGI's File System Navigator. It renders one directory at a time as a WebGL city — directories are districts, files are towers — and the layout is deterministic, so the same folder always looks the same. The web app is read-only; the Tauri desktop app can edit UTF-8 text and open files in their native application.

## Run locally

```sh
pnpm install
pnpm dev:web
```

Then open the local URL printed by Vite.

To run the native app, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system, then run:

```sh
pnpm dev:desktop
```

## Controls

- Drag to orbit; right-drag to pan; scroll to move through the world.
- Move with `W`, `A`, `S`, `D` or the arrow keys.
- Click an object to inspect it; double-click a directory to enter it; `Backspace` returns to the parent.
- Press `/` or `Cmd/Ctrl + K` to search the current directory.
- The directory you are in is written into the location fragment, so back and forward retrace the directories you walked and a reload lands where you left off.

Opening an object gives you an old-school viewer window: text and source, images, 3D models, audio and video, CSV/TSV, JSON, zip manifests, font specimens, PDFs. Audio and video come with a hand-built transport and a choice of visualizers. Anything without a viewer gets an access-denied screen with a hex-dump override — or, on desktop, is handed to its native application when the file policy allows it.

## Local files and privacy

Nothing is uploaded. The **Open folder** control uses the File System Access API where available, falling back to a `webkitdirectory` snapshot; all reading and rendering happens in the browser, and the web app never writes to a file. The address fragment holds directory names from the folder you opened, so analytics strips the fragment from every event before it is sent.

The desktop app gets access only to the directory you choose in the native picker. A Rust-owned active-root capability validates every native filesystem command, and picking another folder revokes the old root — there is no static home-directory or global filesystem scope. Opening a file natively resolves it against that root and refuses symlinks, `..`, absolute components, and executables; text edits save only after an explicit click, using atomic replacement.

## Workspace

FSN is a pnpm workspace with two deliberately separate application shells, orchestrated by [Turborepo](https://turborepo.com/docs).

| Workspace | Responsibility |
| --- | --- |
| `apps/web` | Browser filesystem adapter, remembered browser handles, analytics, web metadata. |
| `apps/desktop` | Tauri v2 shell, native filesystem adapter, capabilities, Rust commands, packaging. |
| `packages/core` | Platform-neutral filesystem model, classification, search, formatting, parsers. |
| `packages/app` | Shared navigator controller, WebGL scene, viewers, styles, shell markup, demo assets. |

`CLAUDE.md` covers the conventions that hold across them. The shared demo model is generated; regenerate it with `node packages/app/tools/make-demo-model.mjs`.

## Verification

```sh
pnpm check
```

That runs all TypeScript checks, tests, and both Vite webview builds. Verify the Rust application separately with:

```sh
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --locked --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```

## Releasing

`pnpm build:desktop` creates a local desktop bundle for the current operating system. Pushing a version tag matching `apps/desktop/package.json` creates an unsigned Apple Silicon draft prerelease:

```sh
pnpm validate:desktop-release v0.1.0
git tag -a v0.1.0 -m "FSN desktop v0.1.0"
git push origin v0.1.0
```

The release workflow verifies the workspace and Rust backend before uploading the app and DMG. Signing and notarization remain separate steps.

## Credits

The demo filesystem plays **"Vice"** from *White Bat XVII*.

> Music by Karl Casey @ White Bat Audio: <https://karlcasey.bandcamp.com/album/white-bat-xvii>

The credit travels with the file: it is shown in the sound player whenever the track is opened, and repeated in `Music/credits.txt` inside the demo filesystem.
