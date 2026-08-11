# FSN — 3D File System Navigator

A browser-based tribute to SGI's File System Navigator. It renders one directory at a time as a deterministic WebGL city and keeps local file access read-only.

## Run locally

```sh
pnpm install
pnpm dev
```

Then open the local URL printed by Vite.

## Controls

- Drag to orbit; right-drag to pan; scroll to move through the world.
- Use `W`, `A`, `S`, `D` or the arrow keys to move.
- Click an object to inspect it; double-click a directory to enter it.
- Press `Backspace` to return to the parent.
- Press `/` or `Cmd/Ctrl + K` to search the current directory.
- Open text, code, image, audio, video, and PDF files in old-school viewer windows. Unknown or executable objects produce an access-denied screen.

## Local files and privacy

The **Open folder** control uses the File System Access API where available. Other browsers fall back to a `webkitdirectory` directory snapshot. Neither mode uploads filenames, metadata, or file contents; all rendering and previewing happens in the browser. The application never writes to selected files.

## Verification

```sh
pnpm test
pnpm build
```
