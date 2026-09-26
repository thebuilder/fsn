import { seeded } from "./bytes";
import { encodePng } from "./png";
import { makeZip, type DosMoment } from "./zip";

const BUILT: DosMoment = { year: 2026, month: 8, day: 10, hour: 23, minute: 41 };

/** A small generated picture, so an archive holds at least one thing DEFLATE cannot shrink. */
function tile(width: number, height: number, seed: number, tint: [number, number, number]): Uint8Array<ArrayBuffer> {
  const random = seeded(seed);
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      const line = x % 8 === 0 || y % 8 === 0 ? 1 : 0.25;
      const grain = random.next() * 0.35;
      tint.forEach((channel, index) => {
        pixels[at + index] = Math.min(255, Math.round(channel * (line + grain) * (1 - y / height / 2)));
      });
    }
  }
  return encodePng(width, height, pixels);
}

/** Minified-looking bundle text: long, repetitive, and so the part of a build that compresses best. */
function bundle(): string {
  const random = seeded(0xb0b);
  const names = ["grid", "tower", "plinth", "fog", "orbit", "flight", "reticle", "crumb", "district", "horizon"];
  const parts = ['"use strict";const e=globalThis;'];
  for (let index = 0; index < 180; index += 1) {
    const name = random.pick(names);
    parts.push(`function ${name}${index}(t,n){const r=t.${random.pick(names)}??${random.int(512)};return n?r*${(random.next() * 4).toFixed(3)}:e.${name}(r)}`);
  }
  parts.push('export{grid0 as boot};\n//# sourceMappingURL=navigator-3f9a1c.js.map\n');
  return parts.join("");
}

/** "build-output.zip": the last build of the fsn-revival project, as a bundler leaves it. */
export function buildOutputZip(): Uint8Array<ArrayBuffer> {
  const js = bundle();
  return makeZip([
    { name: "dist/", modified: BUILT },
    { name: "dist/index.html", modified: BUILT, data: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>FSN Revival</title>\n  <link rel="manifest" href="/fsn.webmanifest">\n  <link rel="stylesheet" href="/assets/phosphor-77f2d4.css">\n  <script type="module" src="/assets/navigator-3f9a1c.js"></script>\n</head>\n<body>\n  <canvas id="world"></canvas>\n</body>\n</html>\n' },
    { name: "dist/fsn.webmanifest", modified: BUILT, data: '{\n  "name": "FSN Revival",\n  "short_name": "FSN",\n  "display": "fullscreen",\n  "background_color": "#060a0b",\n  "theme_color": "#72f7d4"\n}\n' },
    { name: "dist/assets/", modified: BUILT },
    { name: "dist/assets/navigator-3f9a1c.js", modified: BUILT, data: js },
    { name: "dist/assets/navigator-3f9a1c.js.map", modified: BUILT, data: JSON.stringify({ version: 3, file: "navigator-3f9a1c.js", sources: ["../src/main.ts", "../src/scene.ts"], mappings: "AAAA,SAASA;".repeat(400) }) },
    { name: "dist/assets/phosphor-77f2d4.css", modified: BUILT, data: ":root{--phosphor:#72f7d4;--signal:#ff587e;--void:#060a0b}.screen{color:var(--phosphor)}canvas{display:block;width:100vw;height:100vh;background:var(--void)}\n" },
    { name: "dist/assets/grid-7e1b.png", modified: BUILT, data: tile(64, 64, 7, [114, 247, 212]), store: true },
    { name: "dist/BUILD-INFO.txt", modified: BUILT, data: "FSN REVIVAL 0.1.0\nBUILT 2026-08-10 23:41 ON indigo2.lab\nTARGET es2022 / webgl2\nWARNINGS: 0\nHORIZON: NOT REACHED\n" },
  ], "fsn-revival 0.1.0 / deterministic build / do not hand-edit");
}

/** Four reels of a tape log, each a few dozen lines of the same machine talking to itself. */
function reel(number: number): string {
  const random = seeded(0x7ae + number);
  const events = ["BLOCK OK", "BLOCK OK", "BLOCK OK", "RETRY", "BLOCK OK", "SOFT ERROR / RECOVERED", "BLOCK OK"];
  const lines = [`REEL ${String(number).padStart(2, "0")} / 9-TRACK / 6250 BPI`, ""];
  for (let block = 0; block < 48; block += 1) {
    lines.push(`${String(block * 512 + number * 100_000).padStart(8, "0")}  ${random.pick(events)}`);
  }
  lines.push("", number === 4 ? "END OF VOLUME. LABEL ON THE CASE READS: 'VAULT - SEE FIELD NOTES'." : "END OF REEL.");
  return lines.join("\n");
}

/** "archive-001.zip": a tape recovery, with a README, four reels, a scan, and one sealed entry. */
export function archiveZip(): Uint8Array<ArrayBuffer> {
  const recovered: DosMoment = { year: 1996, month: 8, day: 11, hour: 2, minute: 14 };
  const reels = [1, 2, 3, 4].map((number): { name: string; modified: DosMoment; data: string } => ({
    name: `ARCHIVE-001/tapes/reel-${String(number).padStart(2, "0")}.log`,
    modified: { year: 1996, month: 7, day: 20 + number, hour: 9 + number, minute: 5 * number },
    data: reel(number),
  }));
  return makeZip([
    { name: "ARCHIVE-001/", modified: recovered },
    { name: "ARCHIVE-001/README.1ST", modified: recovered, data: "ARCHIVE-001\n===========\n\nRecovered from four reels found in the east platform store room.\nReels 01-03 read cleanly. Reel 04 has soft errors past block 30.\n\nThe vault entry is sealed. Do not brute-force it; ask.\n" },
    { name: "ARCHIVE-001/FILE_ID.DIZ", modified: recovered, data: "+--------------------------+\n| ARCHIVE-001  [4 REELS]   |\n| recovered tape set       |\n| 1 sealed entry           |\n+--------------------------+\n" },
    { name: "ARCHIVE-001/tapes/", modified: recovered },
    ...reels,
    { name: "ARCHIVE-001/scans/", modified: recovered },
    { name: "ARCHIVE-001/scans/label-reel-04.png", modified: recovered, data: tile(96, 64, 4, [255, 180, 90]), store: true },
    { name: "ARCHIVE-001/vault/", modified: recovered },
    {
      name: "ARCHIVE-001/vault/coordinates.txt",
      modified: recovered,
      data: "WEST PLATFORM: 58.331 / -2.120\n\nThere is no west platform on any map.\nIf you are reading this, you found the password in the field notes.\n",
      password: "velociraptor",
    },
  ], "ARCHIVE-001 / RECOVERED FROM TAPE / 1996-08-11 02:14");
}
