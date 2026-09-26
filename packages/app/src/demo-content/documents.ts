/**
 * The prose, source and data files added to the demo filesystem. They live here so
 * `demo.ts` can stay a readable map of the tree rather than a wall of strings.
 *
 * They share one small world with the rest of the demo: an operator on a remote
 * research station, an SGI in the lab, an uplink that keeps degrading and a carrier
 * nobody can place. The pieces cross-reference each other, so following a thread
 * from one district to the next is part of exploring.
 */

export const FIELD_NOTES_JULY = `07.29.2026 FIELD LOG

Walked the east fence at dusk. Segment 7 hums a half-tone lower than the rest; logged it.

Got a clear photo of the thing that has been setting off the motion sensors. Filed it with these notes. If anyone from ops needs the vault password for the tape archive, it is the same as the name of that file. Do not write it down anywhere else.

Uplink dropped twice during the evening pass. Varga says it is the dish. I am not so sure.`;

export const FIELD_NOTES_AUGUST_4 = `08.04.2026 FIELD LOG

The modem answered something at 02:14. Nobody dialled. The recording is in Music as voice-memo.wav; it is only the handshake, there is no voice.

Checked the catalogue for 1420.405 MHz. That is the hydrogen line. Everything in the sky whispers on it. Nothing in the sky should be dialling our modem on it.`;

export const SIGHTINGS_TSV = `DATE\tTIME\tLOCATION\tOBSERVER\tNOTE
2026-07-14\t21:40\tEast fence, seg 5\tVarga\tMotion sensor trip, no visual
2026-07-19\t22:05\tEast fence, seg 7\tOperator\tTracks in mud, three-toed
2026-07-23\t02:14\tDish compound\tVarga\tDish slewed 4 degrees, no command logged
2026-07-29\t20:52\tEast fence, seg 7\tOperator\tPhotographed. See velociraptor.webp
2026-08-01\t03:30\tStore room\tOkafor\tTape reels found behind the generator
2026-08-07\t02:14\tLab\tSystem\tHit counter decremented
2026-08-10\t02:14\tFence, seg 7\tSystem\tSegment offline 40 s
2026-08-11\t02:14\tDownloads\tSystem\tunknown.pkg written, no owning process`;

export const TODO = `TODO — WEEK OF 08.10

[x] Recover the tape reels (archive-001.zip)
[x] File the operator's manual (Downloads/manual.pdf)
[ ] Ask Varga why the dish moved on its own
[ ] Replace fence segment 7 transformer
[ ] Figure out who put unknown.pkg in Downloads
[ ] DO NOT open unknown.pkg
[ ] Budget: explain the media overspend before Q4 review
[ ] Back up the guestbook before the hit counter eats it`;

export const HARDWARE_INVENTORY = `ASSET,MODEL,CPU,MEMORY,LOCATION,STATUS
SGI-0041,Indigo2 Extreme,R4400 200 MHz,128 MB,Lab,In service
SGI-0042,Indy,R4600 133 MHz,64 MB,Lab,In service
SGI-0057,Onyx RealityEngine2,4x R4400,512 MB,Machine room,Rendering the city
SGI-0063,O2,R5000 180 MHz,128 MB,Operator desk,On loan
MAC-0012,Power Macintosh 8500,PowerPC 604 120 MHz,64 MB,Operator desk,This machine
NET-0003,US Robotics Sportster,28.8k modem,-,Comms rack,Answers calls nobody made
RF-0001,3.7 m dish,-,-,Dish compound,Degraded
PWR-0002,Generator B,-,-,Store room,Standby`;

export const NAVIGATOR_TS = `/**
 * The navigator owns one directory at a time. Everything else is scenery.
 */
export type NavigatorOptions = {
  renderer: 'webgl';
  privacy: 'local-only';
};

export class Navigator {
  private history: string[] = [];

  constructor(private readonly options: NavigatorOptions) {}

  boot(): void {
    console.log(\`FSN booting (\${this.options.renderer}, \${this.options.privacy})\`);
    this.enter('/');
  }

  enter(path: string): void {
    this.history.push(path);
    // A district is laid out the same way every time, so it can be learned.
  }

  back(): string | undefined {
    this.history.pop();
    return this.history.at(-1);
  }
}
`;

export const PHOSPHOR_FRAG = `// phosphor.frag — the glow on every tower edge.
precision mediump float;

uniform float uTime;
uniform vec3 uPhosphor;   // #72f7d4
varying vec2 vUv;

void main() {
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float glow = smoothstep(0.08, 0.0, edge);
  float scan = 0.92 + 0.08 * sin(vUv.y * 480.0 + uTime * 6.0);
  gl_FragColor = vec4(uPhosphor * glow * scan, glow);
}
`;

export const BUILD_WORLD_MJS = `#!/usr/bin/env node
// Builds the world. With --grid=infinite it never finishes, which is the point.
const grid = process.argv.find((arg) => arg.startsWith("--grid="))?.split("=")[1] ?? "64";
const size = grid === "infinite" ? Infinity : Number(grid);

let row = 0;
while (row < size) {
  if (row % 1024 === 0) console.log(\`laid row \${row}\`);
  row += 1;
  if (row > 1e6) {
    console.log("the horizon must never quite arrive; stopping here");
    break;
  }
}
`;

export const CHANGELOG_MD = `# Changelog

## 0.1.0 — 2026-08-10

- Directory blocks hold their position when revisited.
- The phosphor grid persists past the fog line.
- Unknown binaries are refused with ERR 0x0007, with a hex dump on request.

## 0.0.3 — 2026-07-28

- Search reaches every directory already visited.
- Towers grow with file size, then stop at seven storeys.

## 0.0.2 — 2026-07-19

- Flight: W A S D, with momentum.
- Fixed: the camera could fly under the grid and see the void.

## 0.0.1 — 2026-07-02

- First light. One directory, eleven towers, no fog.
`;

export const GITIGNORE = `node_modules/
dist/
*.log
.DS_Store
# The build is reproducible; keep the zip out of history.
build-output.zip
`;

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
`;

export const TELEMETRY_JSON = `{
  "spacecraft": "FSN-SAT-1",
  "epoch": "2026-08-11T02:14:00Z",
  "link": { "state": "DEGRADED", "errorRate": 0.412, "lastLock": "2026-08-11T02:14:07Z" },
  "attitude": { "roll": 0.02, "pitch": -0.31, "yaw": 179.6, "mode": "SUN-POINTING" },
  "power": { "bus": 28.1, "battery": 0.87, "panels": ["NOMINAL", "NOMINAL", "DEGRADED"] },
  "thermal": { "radiator": -12.4, "payload": 21.2, "transponder": 41.9 },
  "payload": {
    "receiver": "HYDROGEN LINE SURVEY",
    "centerMHz": 1420.405,
    "detections": [
      { "time": "2026-07-25T01:57:12Z", "durationSeconds": 11, "catalogued": false },
      { "time": "2026-07-30T02:14:03Z", "durationSeconds": 94, "catalogued": false },
      { "time": "2026-08-07T02:14:00Z", "durationSeconds": 212, "catalogued": false }
    ]
  },
  "notes": "Detections repeat at 02:14 local. Ground station clock verified. Not an artefact."
}
`;

export const PASSES_TSV = `PASS\tAOS (UTC)\tLOS (UTC)\tMAX EL\tAZIMUTH\tFRAMES\tDROPPED\tLINK
4118\t2026-08-05 01:12\t2026-08-05 01:23\t64\t212 -> 31\t3412\t9\tNOMINAL
4119\t2026-08-05 02:49\t2026-08-05 02:57\t22\t250 -> 355\t2210\t41\tNOMINAL
4120\t2026-08-06 01:40\t2026-08-06 01:52\t81\t198 -> 18\t3690\t188\tDEGRADED
4121\t2026-08-07 02:08\t2026-08-07 02:19\t47\t230 -> 40\t3120\t1302\tDEGRADED
4122\t2026-08-08 01:31\t2026-08-08 01:42\t59\t205 -> 25\t3301\t240\tDEGRADED
4123\t2026-08-09 02:02\t2026-08-09 02:11\t33\t244 -> 350\t2604\t77\tNOMINAL
4124\t2026-08-10 01:55\t2026-08-10 02:07\t72\t201 -> 22\t3544\t390\tDEGRADED
4125\t2026-08-11 02:09\t2026-08-11 02:20\t88\t190 -> 10\t3821\t1575\tDEGRADED`;

/** A ground track that wraps the station twice, as coordinate pairs in GeoJSON's lon/lat order. */
export function groundTrackGeojson(): string {
  const points: Array<[number, number]> = [];
  for (let step = 0; step <= 48; step += 1) {
    const longitude = -180 + step * 7.5;
    const latitude = Math.round(Math.sin((step / 48) * Math.PI * 4) * 58.3 * 1000) / 1000;
    points.push([longitude, latitude]);
  }
  return `${JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "FSN-SAT-1 ground track", pass: 4125 }, geometry: { type: "LineString", coordinates: points } },
      { type: "Feature", properties: { name: "North platform" }, geometry: { type: "Point", coordinates: [-2.104, 58.334] } },
      { type: "Feature", properties: { name: "East platform" }, geometry: { type: "Point", coordinates: [-2.091, 58.339] } },
      { type: "Feature", properties: { name: "West platform", note: "not on any map" }, geometry: { type: "Point", coordinates: [-2.12, 58.331] } },
    ],
  }, null, 2)}\n`;
}

export const UPLINK_TOML = `# Ground station configuration
[station]
name = "East Platform"
latitude = 58.339
longitude = -2.091

[dish]
diameter_m = 3.7
slew_limit_deg_s = 2.0
# The dish has moved without a command three times. Leave this on.
log_uncommanded_motion = true

[receiver]
center_mhz = 1420.405
bandwidth_khz = 250
record_unknown_carriers = true

[modem]
device = "/dev/ttyS1"
auto_answer = false  # it answers anyway
`;

export const PERSONAL_SITE_CSS = `body {
  background: #000 url("stars.gif");
  color: #0f0;
  font-family: "Comic Sans MS", cursive;
}

h1 {
  text-align: center;
  /* <blink> is deprecated; this is the next best thing. */
  animation: blink 1s steps(2) infinite;
}

@keyframes blink {
  to { visibility: hidden; }
}

a:link { color: #0ff; }
a:visited { color: #f0f; }
`;

export const COUNTER_PL = `#!/usr/bin/perl
# counter.pl — the hit counter. Increments on every visit.
# It has started going backwards after 2 a.m. I did not write that part.
use strict;
use warnings;

my $file = "hits.txt";
open(my $in, "<", $file) or die "no counter: $!";
my $hits = <$in> || 0;
close($in);

$hits++;

open(my $out, ">", $file) or die "cannot write counter: $!";
print $out $hits;
close($out);

print "Content-type: text/html\\n\\n";
print "<p>You are visitor number <b>$hits</b>.</p>\\n";
`;

export const HITS_TXT = "1023\n";

export const PREFERENCES_JSON = `{
  "navigator": {
    "fog": true,
    "gridExtent": "infinite",
    "towerCap": 7,
    "momentum": 0.86,
    "invertOrbit": false
  },
  "display": {
    "phosphor": "#72f7d4",
    "signal": "#ff587e",
    "void": "#060a0b",
    "scanlines": true
  },
  "sound": { "startupChime": true, "keyClicks": false },
  "security": {
    "refuseUnknownBinaries": true,
    "allowHexOverride": true,
    "trustUnlabeledBinaries": false
  },
  "recent": ["/Documents/Field Notes", "/Projects/satellite-uplink", "/Downloads"]
}
`;

export const MODEM_CONF = `# Sportster 28.8 init strings
ATZ
AT&F1
ATS0=0      ; never auto-answer
ATM1L2      ; speaker on until connect, medium volume
# S0=0 is set. The modem still picked up at 02:14 on 08-04.
`;

export const MAIL: Array<{ name: string; ageDays: number; content: string }> = [
  {
    name: "2026-07-15 Welcome aboard.txt",
    ageDays: 27,
    content: `From: Ops <ops@indigo2.lab>
To: operator@east-platform
Date: Wed, 15 Jul 2026 09:00:00
Subject: Welcome aboard

Your account on indigo2 is live. Three rules:

1. The browser build is read-only. Keep it that way.
2. Do not trust unlabeled binaries.
3. If the fence alarm goes, stay in the lab.

The city renders on the Onyx in the machine room. Try not to fly under the grid; you will see the void and it will see you.

— Ops`,
  },
  {
    name: "2026-07-21 RE budget-1996.csv.txt",
    ageDays: 21,
    content: `From: Finance <finance@indigo2.lab>
To: operator@east-platform
Date: Tue, 21 Jul 2026 14:22:00
Subject: RE: budget-1996.csv

Media is over plan in Q1 and Q4 again. I assume the Q4 line is the tape recovery. What was the Q1 line?

Also: the spreadsheet is called budget-1996. It is 2026. Please explain, or at least stop saving over it.`,
  },
  {
    name: "2026-07-23 dish moved.txt",
    ageDays: 19,
    content: `From: M. Varga <varga@east-platform>
To: operator@east-platform
Date: Thu, 23 Jul 2026 02:31:00
Subject: dish moved

Dish slewed four degrees at 02:14. No command in the log. I have locked the drive.

The archive link has been getting worse all month. My money is on the feed horn. Yours?

— M`,
  },
  {
    name: "2026-08-01 tapes from the store room.txt",
    ageDays: 10,
    content: `From: Dr. A. Okafor <okafor@north-platform>
To: operator@east-platform
Date: Sat, 01 Aug 2026 11:05:00
Subject: tapes from the store room

Found four 9-track reels behind generator B. I had them read in; the whole set is in your Downloads as archive-001.zip.

One entry in the vault folder is sealed. I did not seal it. The label on reel 04 says "SEE FIELD NOTES", which I assume means yours.`,
  },
  {
    name: "2026-08-03 fence segment 7.txt",
    ageDays: 8,
    content: `From: Maintenance <maint@indigo2.lab>
To: operator@east-platform
Date: Mon, 03 Aug 2026 07:45:00
Subject: fence segment 7

Transformer on segment 7 is running hot and dropping out for a few seconds at a time, always around 02:14. Replacement is on order. Until then, please do not walk segment 7 after dark.`,
  },
  {
    name: "2026-08-05 comp.sys.sgi digest 412.txt",
    ageDays: 6,
    content: `From: listserv@comp.sys.sgi
To: operator@east-platform
Date: Wed, 05 Aug 2026 06:00:00
Subject: [comp.sys.sgi] digest #412

In this issue:
  1. FSN on an Indigo2 Extreme: how many towers before it chugs?
  2. RE: Onyx for sale, one careful owner, may contain dinosaur bones
  3. Recovering 9-track tapes in 2026 (long)
  4. Is it true you can fly under the grid?

Reply to the list, not to the sender.`,
  },
  {
    name: "2026-08-07 your hit counter.txt",
    ageDays: 4,
    content: `From: Sysop <sysop@bbs>
To: operator@east-platform
Date: Fri, 07 Aug 2026 09:12:00
Subject: your hit counter

Your hit counter went from 1024 to 1023 overnight. counter.pl only ever adds one. Is someone un-visiting your page?

Also somebody signed your guestbook as "visitor #1024" asking the same thing.`,
  },
  {
    name: "2026-08-10 FSN demo tomorrow.txt",
    ageDays: 1,
    content: `From: Ops <ops@indigo2.lab>
To: operator@east-platform
Date: Mon, 10 Aug 2026 17:30:00
Subject: FSN demo tomorrow

Visitors at 10:00. Show them the city, fly them through Pictures, open the manual. If anyone asks: yes, it is a real filesystem, and yes, you really can walk around in it.

Keep them out of Downloads.`,
  },
  {
    name: "2026-08-11 who installed unknown.pkg.txt",
    ageDays: 0,
    content: `From: operator@east-platform
To: ops@indigo2.lab
Date: Tue, 11 Aug 2026 02:20:00
Subject: who installed unknown.pkg?

There is a package in Downloads that nobody downloaded. The kernel log says it was written at 02:14 by pid 0. There is no pid 0.

I have not opened it. FSN will not open it either, which I am starting to think is the most sensible thing about this place.`,
  },
];
