# FSN: 3D File System Navigator

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
- Open objects in old-school viewer windows. Unknown or executable objects produce an access-denied screen, with a `FORCE HEX DUMP` override.

## Object viewers

Each viewer is loaded on demand, so a session only downloads the readers it uses.

| Object | Viewer |
| --- | --- |
| Text, code, Markdown, logs | SimpleText pane with line numbers. Extensionless files (`Makefile`, `LICENSE`, dotfiles) are recognised by name. |
| Images | Canvas viewer with a real resampling pixel filter. Animated GIF/APNG/WebP are decoded frame by frame so the filter does not freeze them. |
| 3D models (`.stl`, `.obj`, `.ply`, `.glb`, `.gltf`) | Orbitable mesh inspector with wireframe and spin toggles. |
| Audio and video | Player with a spectrum meter driven by the live Web Audio signal. |
| `.csv` / `.tsv` | Record sheet with a quoted-field reader and separator detection. |
| `.json` | Collapsible tree with a raw-source toggle. |
| `.zip` / `.jar` | Archive manifest read from the central directory. Nothing is extracted or executed. |
| Fonts (`.ttf`, `.otf`, `.woff`, `.woff2`) | Specimen sheet at a range of sizes. |
| `.pdf` | Embedded document reader. |
| Anything else | Access-denied screen, with an optional hex dump of the first 64 KB. |

## Local files and privacy

The **Open folder** control uses the File System Access API where available. Other browsers fall back to a `webkitdirectory` directory snapshot. Neither mode uploads filenames, metadata, or file contents; all rendering and previewing happens in the browser. The application never writes to selected files.

## Verification

```sh
pnpm test
pnpm build
```

The demo model in `public/demo-models` is generated; regenerate it with:

```sh
node tools/make-demo-model.mjs
```

## Credits

The demo filesystem plays **"Vice"** from *White Bat XVII*.

> Music by Karl Casey @ White Bat Audio: <https://karlcasey.bandcamp.com/album/white-bat-xvii>

The credit travels with the file: it is shown in the sound player whenever the track is opened, and repeated in `Music/credits.txt` inside the demo filesystem.
