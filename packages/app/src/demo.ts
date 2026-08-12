import type { FilesystemRoot, FsNode, FsResource } from "@fsn/core";

const now = Date.now();
const day = 86_400_000;
let demoInstanceSequence = 0;

export type DemoResourceFactory = {
  text(id: string, content: string): FsResource;
  url(id: string, url: string): FsResource;
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

  function track(
    name: string,
    asset: keyof typeof DEMO_AUDIO,
    size: number,
    ageDays: number,
    credit: NonNullable<FsNode["demoCredit"]>,
  ): FsNode {
    return { ...file(name, size, ageDays, undefined, DEMO_AUDIO[asset]), demoCredit: credit };
  }

  return { directory, file, model, photo, track };
}

function assignIds(node: FsNode, parentId: string | null, path: string): FsNode {
  node.id = `demo:${path}`;
  node.parentId = parentId;
  node.children?.forEach((child) => assignIds(child, node.id, `${path}/${encodeURIComponent(child.name)}`));
  return node;
}

const WHITE_BAT = {
  text: "Music by Karl Casey @ White Bat Audio",
  href: "https://karlcasey.bandcamp.com/album/white-bat-xvii",
};

export function createDemoFilesystem(resources: DemoResourceFactory): FilesystemRoot {
  const { directory, file, model, photo, track } = createNodeFactory(resources, demoInstanceSequence++);
  const root = directory("Macintosh HD", [
    directory("Applications", [
      file("HyperCard.app", 4_800_000, 820),
      file("MacPaint.app", 2_100_000, 1_240),
      file("Netscape Navigator.app", 8_900_000, 610),
      file("SimpleText.app", 620_000, 1_500),
      file("System Profiler.app", 1_800_000, 360),
    ]),
    directory("Documents", [
      directory("Field Notes", [
        file("august-11.txt", 4_210, 0, "08.11.2026 FIELD LOG\n\nThe navigator is stable. Directory blocks now hold their position when revisited. The phosphor grid persists past the fog line.\n\nNext: establish a visual language for unknown objects. Do not trust unlabeled binaries."),
        file("coordinates.log", 1_840, 2, "NORTH PLATFORM: 58.334 / -2.104\nEAST PLATFORM: 58.339 / -2.091\nSIGNAL: NOMINAL\nARCHIVE LINK: DEGRADED"),
        photo("velociraptor.webp", 242_676, 0),
      ]),
      file("README.txt", 12_840, 1, "FILE SYSTEM NAVIGATOR / OPERATOR'S NOTES\n\nWelcome to FSN.\n\n• Drag to orbit the filesystem.\n• Scroll to move through the scene.\n• Fly with W A S D, turn with the arrows; Alt swaps the two.\n• Select an object to inspect it.\n• Double-click, or double-tap, a directory to enter it.\n• Press Backspace to return to the parent.\n\nAll local files remain on your machine."),
      file("project-brief.md", 32_100, 4, "# Project FSN\n\nA spatial interface for exploring ordinary files as an electric city.\n\n## Principles\n\n1. One directory is one navigable district.\n2. The layout is deterministic.\n3. The browser remains read-only.\n4. Useful information lives in HTML; spectacle lives in WebGL."),
      file("budget-1996.csv", 8_600, 9, "CATEGORY,Q1,Q2,Q3,Q4\nHardware,4200,1800,600,900\nSoftware,350,420,215,610\nMedia,1200,700,880,1500\nNetwork,240,240,240,240"),
      file("classified.dat", 48_000_000, 40),
    ]),
    directory("Pictures", [
      photo("mountain-pass.webp", 246_234, 7),
      photo("neon-coast.webp", 87_066, 12),
      photo("terminal-room.webp", 143_944, 1),
      photo("system-garden.webp", 398_758, 3),
      file("contact-sheet.tif", 7_400_000, 26),
    ]),
    directory("Projects", [
      directory("fsn-revival", [
        directory("src", [
          file("main.ts", 14_220, 0, "import { Navigator } from './navigator';\n\nconst fsn = new Navigator({\n  renderer: 'webgl',\n  privacy: 'local-only',\n});\n\nfsn.boot();"),
          file("scene.ts", 28_900, 0, "export function createWorld() {\n  // The horizon must never quite arrive.\n  return { fog: true, grid: Infinity };\n}"),
          file("phosphor.css", 6_420, 2, ":root {\n  --phosphor: #72f7d4;\n  --signal: #ff587e;\n  --void: #060a0b;\n}\n\n.screen {\n  color: var(--phosphor);\n}"),
        ]),
        file("package.json", 1_820, 0, "{\n  \"name\": \"fsn-revival\",\n  \"private\": true,\n  \"version\": \"0.1.0\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"tsc && vite build\"\n  },\n  \"dependencies\": {\n    \"three\": \"^0.179.1\"\n  }\n}"),
        file("Makefile", 640, 5, "PHOSPHOR := 72f7d4\n\ndev:\n\tpnpm vite\n\nworld:\n\tnode tools/build-world.mjs --grid=infinite\n\n.PHONY: dev world\n"),
        file("build-output.zip", 18_400_000, 1),
      ]),
      directory("satellite-uplink", [file("antenna.py", 18_200, 18, "def establish_link(frequency):\n    print(f'LOCKING {frequency} MHz')\n    return True\n"), file("telemetry.bin", 90_000_000, 1), model("resonator-coil.stl", 256_084, 11), photo("satellite-uplink.webp", 237_258, 6)]),
      directory("personal-site", [file("index.html", 4_820, 70, "<!doctype html>\n<title>Daniel's Home Page</title>\n<h1>Welcome to my corner of the World Wide Web</h1>"), file("guestbook.db", 884_000, 30)]),
    ]),
    directory("Music", [
      file("ambient-loop.aiff", 32_000_000, 90),
      track("Karl Casey - Vice.mp3", "karl-casey-vice.mp3", 8_182_387, 21, WHITE_BAT),
      file("voice-memo.wav", 3_200_000, 3),
      file("credits.txt", 420, 21, `MUSIC CREDITS\n\n"Vice" from White Bat XVII\n${WHITE_BAT.text}\n${WHITE_BAT.href}\n\nUsed with credit, as the artist requires.`),
    ]),
    directory("Downloads", [file("archive-001.zip", 84_000_000, 14), file("manual.pdf", 4_200_000, 3), file("unknown.pkg", 142_000_000, 0), photo("incoming-signal.webp", 198_036, 1), photo("archive-vault.webp", 198_490, 14)]),
    directory("System", [directory("Extensions", [file("AppleScript", 98_000, 1_800), file("QuickTime™", 1_800_000, 1_600), file("Sound Manager", 440_000, 1_900)]), file("System", 12_000_000, 2_000), file("Finder", 1_400_000, 1_980), photo("last-login.webp", 223_890, 0)]),
    file("About this computer.txt", 2_400, 100, "SYSTEM SOFTWARE 7.5.3\nBUILT-IN MEMORY: 64 MB\nLARGEST UNUSED BLOCK: 42.1 MB\n\nThe future is spatial."),
  ]);
  assignIds(root, null, encodeURIComponent(root.name));
  return { root, sourceLabel: "DEMO FILESYSTEM / SIMULATION", isLocal: false };
}
