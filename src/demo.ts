import type { FilesystemRoot, FsNode } from "./filesystem";

const now = Date.now();
const day = 86_400_000;

function file(name: string, size: number, ageDays: number, content?: string, demoImage?: string): FsNode {
  return { id: "", parentId: null, name, kind: "file", size, modified: now - ageDays * day, demoContent: content, demoImage };
}

function directory(name: string, children: FsNode[]): FsNode {
  return { id: "", parentId: null, name, kind: "directory", children };
}

function assignIds(node: FsNode, parentId: string | null, path: string): FsNode {
  node.id = `demo:${path}`;
  node.parentId = parentId;
  node.children?.forEach((child) => assignIds(child, node.id, `${path}/${encodeURIComponent(child.name)}`));
  return node;
}

function postcardSvg(title: string, sky: string, ground: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="${sky}"/><circle cx="740" cy="135" r="78" fill="#fff3bd"/><path d="M0 420 220 210l170 165 145-122 250 205 175-118v300H0z" fill="${ground}"/><path d="M0 493 228 306l132 126 166-112 202 168 232-99v251H0z" fill="#16292b" opacity=".72"/><text x="54" y="86" font-family="monospace" font-size="34" fill="#f8fff2">${title}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createDemoFilesystem(): FilesystemRoot {
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
        file("august-11.txt", 4_210, 0, "08.11.2026 — FIELD LOG\n\nThe navigator is stable. Directory blocks now hold their position when revisited. The phosphor grid persists past the fog line.\n\nNext: establish a visual language for unknown objects. Do not trust unlabeled binaries."),
        file("coordinates.log", 1_840, 2, "NORTH PLATFORM: 58.334 / -2.104\nEAST PLATFORM: 58.339 / -2.091\nSIGNAL: NOMINAL\nARCHIVE LINK: DEGRADED"),
      ]),
      file("README.txt", 12_840, 1, "FILE SYSTEM NAVIGATOR / OPERATOR'S NOTES\n\nWelcome to FSN.\n\n• Drag to orbit the filesystem.\n• Scroll to move through the scene.\n• Select an object to inspect it.\n• Double-click a directory to enter it.\n• Press Backspace to return to the parent.\n\nAll local files remain on your machine."),
      file("project-brief.md", 32_100, 4, "# Project FSN\n\nA spatial interface for exploring ordinary files as an electric city.\n\n## Principles\n\n1. One directory is one navigable district.\n2. The layout is deterministic.\n3. The browser remains read-only.\n4. Useful information lives in HTML; spectacle lives in WebGL."),
      file("budget-1996.csv", 8_600, 9, "CATEGORY,Q1,Q2,Q3,Q4\nHardware,4200,1800,600,900\nSoftware,350,420,215,610\nMedia,1200,700,880,1500\nNetwork,240,240,240,240"),
      file("classified.dat", 48_000_000, 40),
    ]),
    directory("Pictures", [
      file("mountain-pass.png", 1_920_000, 7, undefined, postcardSvg("MOUNTAIN PASS / 06:42", "#cf426a", "#55e2d1")),
      file("neon-coast.jpg", 2_480_000, 12, undefined, postcardSvg("NEON COAST / ROLL 04", "#5a2f80", "#ef5675")),
      file("terminal-room.webp", 980_000, 1, undefined, postcardSvg("TERMINAL ROOM / LEVEL 3", "#074e58", "#de5f81")),
      file("contact-sheet.tif", 7_400_000, 26),
    ]),
    directory("Projects", [
      directory("fsn-revival", [
        directory("src", [
          file("main.ts", 14_220, 0, "import { Navigator } from './navigator';\n\nconst fsn = new Navigator({\n  renderer: 'webgl',\n  privacy: 'local-only',\n});\n\nfsn.boot();"),
          file("scene.ts", 28_900, 0, "export function createWorld() {\n  // The horizon must never quite arrive.\n  return { fog: true, grid: Infinity };\n}"),
          file("phosphor.css", 6_420, 2, ":root {\n  --phosphor: #72f7d4;\n  --signal: #ff587e;\n  --void: #060a0b;\n}\n\n.screen {\n  color: var(--phosphor);\n}"),
        ]),
        file("package.json", 1_820, 0, "{\n  \"name\": \"fsn-revival\",\n  \"private\": true,\n  \"version\": \"0.1.0\"\n}"),
        file("build-output.zip", 18_400_000, 1),
      ]),
      directory("satellite-uplink", [file("antenna.py", 18_200, 18, "def establish_link(frequency):\n    print(f'LOCKING {frequency} MHz')\n    return True\n"), file("telemetry.bin", 90_000_000, 1)]),
      directory("personal-site", [file("index.html", 4_820, 70, "<!doctype html>\n<title>Daniel's Home Page</title>\n<h1>Welcome to my corner of the World Wide Web</h1>"), file("guestbook.db", 884_000, 30)]),
    ]),
    directory("Music", [file("ambient-loop.aiff", 32_000_000, 90), file("night-drive.mp3", 8_400_000, 21), file("voice-memo.wav", 3_200_000, 3)]),
    directory("Downloads", [file("archive-001.zip", 84_000_000, 14), file("manual.pdf", 4_200_000, 3), file("unknown.pkg", 142_000_000, 0), file("signal.gif", 820_000, 1, undefined, postcardSvg("INCOMING SIGNAL", "#10283a", "#ff4f83"))]),
    directory("System", [directory("Extensions", [file("AppleScript", 98_000, 1_800), file("QuickTime™", 1_800_000, 1_600), file("Sound Manager", 440_000, 1_900)]), file("System", 12_000_000, 2_000), file("Finder", 1_400_000, 1_980)]),
    file("About this computer.txt", 2_400, 100, "SYSTEM SOFTWARE 7.5.3\nBUILT-IN MEMORY: 64 MB\nLARGEST UNUSED BLOCK: 42.1 MB\n\nThe future is spatial."),
  ]);
  assignIds(root, null, encodeURIComponent(root.name));
  return { root, sourceLabel: "DEMO FILESYSTEM / SIMULATION", isLocal: false };
}
