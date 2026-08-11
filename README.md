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
| Audio and video | Player with custom transport controls and switchable visualizers (see below). |
| `.csv` / `.tsv` | Record sheet with a quoted-field reader and separator detection. |
| `.json` | Collapsible tree with a raw-source toggle. |
| `.zip` / `.jar` | Archive manifest read from the central directory. Nothing is extracted or executed. |
| Fonts (`.ttf`, `.otf`, `.woff`, `.woff2`) | Specimen sheet at a range of sizes. |
| `.pdf` | Embedded document reader. |
| Anything else | Access-denied screen, with an optional hex dump of the first 64 KB. |

## The sound player

The browser's own media controls are switched off; the deck draws its own transport
(play/pause, stop, seek, volume), which is keyboard operable — `Space` toggles play,
arrows scrub, `Shift` + arrows scrub further.

Playback starts on open where the browser permits it. Opening the object is itself a
gesture, so it usually does; when it refuses, the deck waits and says so rather than
falling back to muted autoplay, which would look like it was playing while producing
silence.

Audio opens onto one of three visualizers, all fed from a single `AnalyserNode`:

- **GRID** — a synthwave landscape, driven by two separate things.

  The spectrum is written one row at a time at the horizon into a scrolling height
  texture, and travels toward you: the slow landscape. On its own it cannot feel like
  the music, because at this road length and speed a ridge takes about seven seconds
  to arrive. So each detected onset also fires a **shockwave** that crosses the whole
  road in roughly four tenths of a second — that is what actually reads as being on
  the beat, alongside the flash, the sun flare and the camera kick.

  The grid is real geometry: line segments between neighbouring vertices of the
  displaced lattice, not a `fract()` pattern painted onto a plane. The painted version
  only agrees with the surface when the cell size happens to match the vertex spacing;
  otherwise the lines float free and every ridge tears along a seam.
- **BARS** — log-spaced spectrum with peak caps and a reflection.
- **SCOPE** — oscilloscope with phosphor persistence.

Video keeps the picture and gets a slim spectrum strip beneath it. Pausing lets the
world settle, and `prefers-reduced-motion` slows the travel and drops the beat-driven
camera kick. Seeking reseeds the terrain from the new position rather than zeroing it,
since a buffer of silence meeting live audio puts a vertical cliff across the road.

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
