import { mimeTypeFor, type FilesystemRoot, type FsNode, type FsResource } from "@fsn/core";
import type { GeneratorId } from "./demo-content/generated";
import {
  BUILD_WORLD_MJS,
  CHANGELOG_MD,
  COUNTER_PL,
  FIELD_NOTES_AUGUST_4,
  FIELD_NOTES_JULY,
  GITIGNORE,
  HARDWARE_INVENTORY,
  HITS_TXT,
  MAIL,
  MODEM_CONF,
  NAVIGATOR_TS,
  PASSES_TSV,
  PERSONAL_SITE_CSS,
  PHOSPHOR_FRAG,
  PREFERENCES_JSON,
  SIGHTINGS_TSV,
  TELEMETRY_JSON,
  TODO,
  TSCONFIG,
  UPLINK_TOML,
  groundTrackGeojson,
} from "./demo-content/documents";
import { dailyLogs, uplinkJournal } from "./demo-content/logs";

const now = Date.now();
const encoder = new TextEncoder();
const day = 86_400_000;
let demoInstanceSequence = 0;

export type DemoResourceFactory = {
  text(id: string, content: string): FsResource;
  url(id: string, url: string): FsResource;
  /**
   * Bytes built in the page rather than shipped: archives, sound, a PDF, a picture and
   * the binaries behind the locked objects. `read` does the building on first call and
   * hands back the same Blob afterwards, so an adapter only has to store it and call it.
   */
  bytes(id: string, read: () => Promise<Blob>): FsResource;
};

const DEMO_IMAGES = {
  "archive-vault.webp": new URL("./assets/demo-images/archive-vault.webp", import.meta.url).href,
  "incoming-signal.webp": new URL("./assets/demo-images/incoming-signal.webp", import.meta.url).href,
  "last-login.webp": new URL("./assets/demo-images/last-login.webp", import.meta.url).href,
  "mountain-pass.webp": new URL("./assets/demo-images/mountain-pass.webp", import.meta.url).href,
  "neon-coast.webp": new URL("./assets/demo-images/neon-coast.webp", import.meta.url).href,
  "satellite-uplink.webp": new URL("./assets/demo-images/satellite-uplink.webp", import.meta.url).href,
  "system-garden.webp": new URL("./assets/demo-images/system-garden.webp", import.meta.url).href,
  "terminal-room.webp": new URL("./assets/demo-images/terminal-room.webp", import.meta.url).href,
  "velociraptor.webp": new URL("./assets/demo-images/velociraptor.webp", import.meta.url).href,
} as const;

const DEMO_MODELS = {
  "resonator-coil.stl": new URL("./assets/demo-models/resonator-coil.stl", import.meta.url).href,
} as const;

const DEMO_AUDIO = {
  "karl-casey-vice.mp3": new URL("./assets/demo-audio/karl-casey-vice.mp3", import.meta.url).href,
} as const;

/**
 * Kenney's pixel face, public domain (CC0), taken from the three.js examples. That copy's
 * cmap points one glyph past the end, which Chromium's font sanitiser rejects outright,
 * so the committed file is the same font re-saved with fontTools without that entry.
 */
const DEMO_FONTS = {
  "kenpixel.ttf": new URL("./assets/demo-fonts/kenpixel.ttf", import.meta.url).href,
} as const;

/**
 * Builds a generated object's bytes once, on first read. The generators sit behind a
 * dynamic import so none of their code is fetched until somebody opens one; a failed
 * fetch forgets itself, so the next attempt can succeed where this one did not.
 */
function lazyBlob(name: string, generator: GeneratorId): () => Promise<Blob> {
  let pending: Promise<Blob> | undefined;
  return () => {
    pending ??= import("./demo-content/generated").then(({ generators }) =>
      new Blob([generators[generator]()], { type: mimeTypeFor(name) }),
    );
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
}

function createNodeFactory(resources: DemoResourceFactory, instanceId: number) {
  let resourceSequence = 0;

  function file(name: string, size: number, ageDays: number, content?: string, asset?: string): FsNode {
    const resourceId = `demo:${instanceId}:resource:${resourceSequence++}`;
    const resource = content !== undefined
      ? resources.text(resourceId, content)
      : asset
        ? resources.url(resourceId, asset)
        : undefined;
    return { id: "", parentId: null, name, kind: "file", size, modified: now - ageDays * day, resource };
  }

  function directory(name: string, children: FsNode[]): FsNode {
    return { id: "", parentId: null, name, kind: "directory", children };
  }

  function photo(name: keyof typeof DEMO_IMAGES, size: number, ageDays: number): FsNode {
    return file(name, size, ageDays, undefined, DEMO_IMAGES[name]);
  }

  function model(name: keyof typeof DEMO_MODELS, size: number, ageDays: number): FsNode {
    return file(name, size, ageDays, undefined, DEMO_MODELS[name]);
  }

  /** A file whose bytes are generated in the page; see `demo-content/generated.ts`. */
  function generated(name: string, size: number, ageDays: number, generator: GeneratorId): FsNode {
    const resourceId = `demo:${instanceId}:resource:${resourceSequence++}`;
    const resource = resources.bytes(resourceId, lazyBlob(name, generator));
    return { id: "", parentId: null, name, kind: "file", size, modified: now - ageDays * day, resource };
  }

  function font(name: string, asset: keyof typeof DEMO_FONTS, size: number, ageDays: number): FsNode {
    return file(name, size, ageDays, undefined, DEMO_FONTS[asset]);
  }

  function track(
    name: string,
    asset: keyof typeof DEMO_AUDIO,
    size: number,
    ageDays: number,
    credit: NonNullable<FsNode["demoCredit"]>,
  ): FsNode {
    return { ...file(name, size, ageDays, undefined, DEMO_AUDIO[asset]), demoCredit: credit };
  }

  return { directory, file, font, generated, model, photo, track };
}

function assignIds(node: FsNode, parentId: string | null, path: string): FsNode {
  node.id = `demo:${path}`;
  node.parentId = parentId;
  node.children?.forEach((child) => assignIds(child, node.id, `${path}/${encodeURIComponent(child.name)}`));
  return node;
}

/**
 * The true byte counts of the generated files a viewer shows whole — pictures, sound,
 * documents, archives — so the size in a window's title bar agrees with what the
 * window displays. The locked binaries keep their larger catalogue sizes instead: the
 * hex monitor shows only the first 64 KB of any object, so for those the claim holds.
 * `demo.test.ts` fails with the right number if a generator changes.
 */
export const GENERATED_SIZES = {
  contactSheet: 155_116,
  buildOutput: 14_630,
  guestbook: 8_192,
  ambientLoop: 352_844,
  modemHandshake: 291_104,
  archive: 17_392,
  manual: 11_002,
} as const;

const WHITE_BAT = {
  text: "Music by Karl Casey @ White Bat Audio",
  href: "https://karlcasey.bandcamp.com/album/white-bat-xvii",
};

export function createDemoFilesystem(resources: DemoResourceFactory): FilesystemRoot {
  const { directory, file, font, generated, model, photo, track } = createNodeFactory(resources, demoInstanceSequence++);
  const text = (name: string, ageDays: number, content: string): FsNode => file(name, encoder.encode(content).length, ageDays, content);
  const root = directory("Macintosh HD", [
    directory("Applications", [
      generated("HyperCard.app", 4_800_000, 820, "hyperCard"),
      generated("MacPaint.app", 2_100_000, 1_240, "macPaint"),
      generated("Netscape Navigator.app", 8_900_000, 610, "netscape"),
      generated("SimpleText.app", 620_000, 1_500, "simpleText"),
      generated("System Profiler.app", 1_800_000, 360, "systemProfiler"),
    ]),
    directory("Documents", [
      directory("Field Notes", [
        file("august-11.txt", 4_210, 0, "08.11.2026 FIELD LOG\n\nThe navigator is stable. Directory blocks now hold their position when revisited. The phosphor grid persists past the fog line.\n\nNext: establish a visual language for unknown objects. Do not trust unlabeled binaries."),
        text("august-04.txt", 7, FIELD_NOTES_AUGUST_4),
        text("july-29.txt", 13, FIELD_NOTES_JULY),
        file("coordinates.log", 1_840, 2, "NORTH PLATFORM: 58.334 / -2.104\nEAST PLATFORM: 58.339 / -2.091\nSIGNAL: NOMINAL\nARCHIVE LINK: DEGRADED"),
        text("sightings.tsv", 0, SIGHTINGS_TSV),
        photo("velociraptor.webp", 242_676, 0),
      ]),
      file("README.txt", 12_840, 1, "FILE SYSTEM NAVIGATOR / OPERATOR'S NOTES\n\nWelcome to FSN.\n\n• Drag to orbit the filesystem.\n• Scroll to move through the scene.\n• Fly with W A S D, turn with the arrows; Alt swaps the two.\n• Select an object to inspect it.\n• Double-click, or double-tap, a directory to enter it.\n• Press Backspace to return to the parent.\n\nAll local files remain on your machine."),
      file("project-brief.md", 32_100, 4, "# Project FSN\n\nA spatial interface for exploring ordinary files as an electric city.\n\n## Principles\n\n1. One directory is one navigable district.\n2. The layout is deterministic.\n3. The browser remains read-only.\n4. Useful information lives in HTML; spectacle lives in WebGL."),
      file("budget-1996.csv", 8_600, 9, "CATEGORY,Q1,Q2,Q3,Q4\nHardware,4200,1800,600,900\nSoftware,350,420,215,610\nMedia,1200,700,880,1500\nNetwork,240,240,240,240"),
      text("hardware-inventory.csv", 16, HARDWARE_INVENTORY),
      text("todo.txt", 1, TODO),
      generated("classified.dat", 48_000_000, 40, "classified"),
    ]),
    directory("Pictures", [
      photo("mountain-pass.webp", 246_234, 7),
      photo("neon-coast.webp", 87_066, 12),
      photo("terminal-room.webp", 143_944, 1),
      photo("system-garden.webp", 398_758, 3),
      generated("contact-sheet.png", GENERATED_SIZES.contactSheet, 26, "contactSheet"),
    ]),
    directory("Projects", [
      directory("fsn-revival", [
        directory("src", [
          file("main.ts", 14_220, 0, "import { Navigator } from './navigator';\n\nconst fsn = new Navigator({\n  renderer: 'webgl',\n  privacy: 'local-only',\n});\n\nfsn.boot();"),
          text("navigator.ts", 0, NAVIGATOR_TS),
          file("scene.ts", 28_900, 0, "export function createWorld() {\n  // The horizon must never quite arrive.\n  return { fog: true, grid: Infinity };\n}"),
          file("phosphor.css", 6_420, 2, ":root {\n  --phosphor: #72f7d4;\n  --signal: #ff587e;\n  --void: #060a0b;\n}\n\n.screen {\n  color: var(--phosphor);\n}"),
          text("phosphor.frag", 2, PHOSPHOR_FRAG),
        ]),
        directory("tools", [text("build-world.mjs", 5, BUILD_WORLD_MJS)]),
        text(".gitignore", 30, GITIGNORE),
        text("CHANGELOG.md", 1, CHANGELOG_MD),
        file("package.json", 1_820, 0, "{\n  \"name\": \"fsn-revival\",\n  \"private\": true,\n  \"version\": \"0.1.0\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"tsc && vite build\"\n  },\n  \"dependencies\": {\n    \"three\": \"^0.179.1\"\n  }\n}"),
        text("tsconfig.json", 40, TSCONFIG),
        file("Makefile", 640, 5, "PHOSPHOR := 72f7d4\n\ndev:\n\tpnpm vite\n\nworld:\n\tnode tools/build-world.mjs --grid=infinite\n\n.PHONY: dev world\n"),
        generated("build-output.zip", GENERATED_SIZES.buildOutput, 1, "buildOutput"),
      ]),
      directory("satellite-uplink", [
        file("antenna.py", 18_200, 18, "def establish_link(frequency):\n    print(f'LOCKING {frequency} MHz')\n    return True\n"),
        text("config.toml", 12, UPLINK_TOML),
        text("ground-track.geojson", 1, groundTrackGeojson()),
        text("passes.tsv", 0, PASSES_TSV),
        text("telemetry.json", 0, TELEMETRY_JSON),
        generated("telemetry.bin", 90_000_000, 1, "telemetry"),
        model("resonator-coil.stl", 256_084, 11),
        photo("satellite-uplink.webp", 237_258, 6),
      ]),
      directory("personal-site", [
        file("index.html", 4_820, 70, "<!doctype html>\n<title>Daniel's Home Page</title>\n<h1>Welcome to my corner of the World Wide Web</h1>"),
        text("style.css", 70, PERSONAL_SITE_CSS),
        text("counter.pl", 70, COUNTER_PL),
        text("hits.txt", 4, HITS_TXT),
        generated("guestbook.db", GENERATED_SIZES.guestbook, 0, "guestbook"),
      ]),
    ]),
    directory("Mail", MAIL.map((message) => text(message.name, message.ageDays, message.content))),
    directory("Logs", [
      ...dailyLogs().map((log) => text(log.name, log.ageDays, log.content)),
      text("uplink.jsonl", 0, uplinkJournal()),
    ]),
    directory("Music", [
      generated("ambient-loop.wav", GENERATED_SIZES.ambientLoop, 90, "ambientLoop"),
      track("Karl Casey - Vice.mp3", "karl-casey-vice.mp3", 8_182_387, 21, WHITE_BAT),
      generated("voice-memo.wav", GENERATED_SIZES.modemHandshake, 7, "modemHandshake"),
      file("credits.txt", 420, 21, `MUSIC CREDITS\n\n"Vice" from White Bat XVII\n${WHITE_BAT.text}\n${WHITE_BAT.href}\n\nUsed with credit, as the artist requires.`),
    ]),
    directory("Downloads", [
      generated("archive-001.zip", GENERATED_SIZES.archive, 10, "archive"),
      generated("manual.pdf", GENERATED_SIZES.manual, 3, "manual"),
      generated("unknown.pkg", 142_000_000, 0, "unknownPackage"),
      photo("incoming-signal.webp", 198_036, 1),
      photo("archive-vault.webp", 198_490, 14),
    ]),
    directory("System", [
      directory("Extensions", [
        generated("AppleScript", 98_000, 1_800, "appleScript"),
        generated("QuickTime™", 1_800_000, 1_600, "quickTime"),
        generated("Sound Manager", 440_000, 1_900, "soundManager"),
      ]),
      directory("Fonts", [
        generated("Geneva", 212_000, 2_000, "geneva"),
        font("Kenney Pixel.ttf", "kenpixel.ttf", 17_428, 400),
      ]),
      directory("Preferences", [
        generated("Finder Preferences", 12_400, 2, "finderPreferences"),
        text("fsn-preferences.json", 1, PREFERENCES_JSON),
        text("modem.conf", 7, MODEM_CONF),
      ]),
      generated("System", 12_000_000, 2_000, "system"),
      generated("Finder", 1_400_000, 1_980, "finder"),
      photo("last-login.webp", 223_890, 0),
    ]),
    file("About this computer.txt", 2_400, 100, "SYSTEM SOFTWARE 7.5.3\nBUILT-IN MEMORY: 64 MB\nLARGEST UNUSED BLOCK: 42.1 MB\n\nThe future is spatial."),
  ]);
  assignIds(root, null, encodeURIComponent(root.name));
  return { root, sourceLabel: "DEMO FILESYSTEM / SIMULATION", isLocal: false };
}
