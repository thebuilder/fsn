import { ByteWriter, seeded, utf8, type Random } from "./bytes";
import { deflateZlib } from "./deflate";

/**
 * Bytes for the objects FSN is meant to refuse: applications, system files and
 * mysteries. They still route to ACCESS DENIED, but because there are bytes behind
 * them the denial offers FORCE HEX DUMP, and the dump rewards the curious — a real
 * magic number in the first row, and some strings further down worth finding.
 *
 * Most are exactly one hex window long, so the viewer's "FIRST 64 KB OF …" reads as
 * the start of a much larger file, which is what the catalogue claims they are.
 */
export const HEX_WINDOW = 64 * 1024;

/** Fills the rest of a buffer with noise, dropping each string in at a spread of offsets. */
function scatter(out: ByteWriter, length: number, random: Random, strings: string[], filler: (random: Random) => number): Uint8Array<ArrayBuffer> {
  const remaining = length - out.length;
  const slots = strings.map((_, index) => out.length + Math.floor(((index + 0.5) / strings.length) * remaining));
  let next = 0;
  while (out.length < length) {
    if (next < slots.length && out.length >= slots[next]) {
      out.text(strings[next]).u8(0);
      next += 1;
    } else {
      out.u8(filler(random));
    }
  }
  return out.finish().slice(0, length);
}

/** Byte noise shaped like 32-bit PowerPC code: a few real opcodes among plausible words. */
function powerPcFiller(): (random: Random) => number {
  // mflr r0, stw r31, blr, lwz r3, li r3 0, mtctr r12, bctrl, nop.
  const opcodes = [0x7c0802a6, 0x93e1fffc, 0x4e800020, 0x80630000, 0x38600000, 0x7d8903a6, 0x4e800421, 0x60000000];
  let word = 0;
  let left = 0;
  return (random) => {
    if (left === 0) {
      word = random.chance(0.4) ? random.pick(opcodes) : (random.int(0x10000) << 16) | random.int(0x10000);
      left = 4;
    }
    left -= 1;
    return (word >>> (left * 8)) & 0xff;
  };
}

/**
 * A classic Mac OS application: a PEF container ("Joy!peffpwpc"), the format
 * PowerPC Macs loaded code from, followed by code-like words and the strings the
 * program would have shown.
 */
export function pefApplication(name: string, strings: string[], seed: number): Uint8Array<ArrayBuffer> {
  const random = seeded(seed);
  const out = new ByteWriter()
    .text("Joy!").text("peff").text("pwpc")
    .u32be(1)
    // Seconds since 1904, the Mac epoch: 11 August 1996.
    .u32be(2_922_220_800)
    .u32be(0).u32be(0).u32be(0x0100_0000)
    .u16be(3).u16be(2).u32be(0);
  out.text(`${name}\0`);
  return scatter(out, HEX_WINDOW, random, strings, powerPcFiller());
}

/**
 * A resource-fork file, the way the System, Finder and every extension shipped: a
 * sixteen-byte header, then resource data, with the resource type codes readable
 * throughout.
 */
export function resourceFile(types: string[], strings: string[], seed: number): Uint8Array<ArrayBuffer> {
  const random = seeded(seed);
  const out = new ByteWriter().u32be(256).u32be(HEX_WINDOW - 512).u32be(HEX_WINDOW - 512 - 256).u32be(256).zeros(240);
  const tagged = strings.flatMap((text, index) => [types[index % types.length], text]);
  return scatter(out, HEX_WINDOW, random, tagged, (source) => (source.chance(0.3) ? 0 : source.int(256)));
}

/** "classified.dat": a sealed container. Almost all of it is ciphertext; almost. */
export function classifiedData(): Uint8Array<ArrayBuffer> {
  const random = seeded(0xc1a55);
  const out = new ByteWriter().text("FSN/SEALED").u8(0).u8(0x1a).u16be(7).u32be(0xdeadbeef).text("EYES ONLY", 16);
  return scatter(out, HEX_WINDOW, random, [
    "IF YOU CAN READ THIS, THE HEX DUMP WORKS.",
    "NOTHING ELSE IN HERE IS FOR YOU.",
    "(THE ARCHIVE PASSWORD IS NOT IN THIS FILE. TRY THE FIELD NOTES.)",
  ], (source) => source.int(256));
}

/**
 * "telemetry.bin": 256-byte frames, each opened by the CCSDS attached sync marker
 * 1ACFFC1D the way real spacecraft downlinks are. Frame counters climb, sensors
 * wander, and a handful of frames carry a status line in plain ASCII.
 */
export function telemetryFrames(): Uint8Array<ArrayBuffer> {
  const random = seeded(0x1acf);
  const out = new ByteWriter();
  const frames = HEX_WINDOW / 256;
  let temperature = 212;
  for (let frame = 0; frame < frames; frame += 1) {
    const start = out.length;
    out.u32be(0x1acffc1d).u16be(0x0c4a).u16be(frame).u32be(849_312_000 + frame * 4);
    temperature += random.int(3) - 1;
    out.u16be(temperature).u16be(2_800 + random.int(40)).u16be(512 + random.int(8));
    const status = frame % 64 === 17
      ? "UNKNOWN CARRIER 1420.405 MHZ / SOURCE NOT IN CATALOGUE"
      : frame % 16 === 0
        ? `LOCK ${String(frame).padStart(4, "0")} / SIGNAL NOMINAL / ARCHIVE LINK DEGRADED`
        : "";
    if (status) out.text(status);
    while (out.length < start + 252) out.u8(random.int(256));
    out.u32be(0x55aa_55aa ^ frame);
  }
  return out.finish();
}

/**
 * "unknown.pkg": a xar archive, the container macOS installers use, with a
 * genuinely zlib-compressed table of contents. What it would install is left to the
 * imagination; the payload's few readable strings do not help.
 */
export function unknownPackage(): Uint8Array<ArrayBuffer> {
  const toc = utf8(`<?xml version="1.0" encoding="UTF-8"?>
<xar><toc><creation-time>1996-08-11T02:14:00</creation-time>
<file id="1"><name>Payload</name><type>file</type></file>
<file id="2"><name>Scripts</name><type>file</type></file>
<file id="3"><name>PackageInfo</name><type>file</type></file>
</toc></xar>`);
  const compressed = deflateZlib(toc);
  const random = seeded(0x9a1d);
  const out = new ByteWriter()
    .text("xar!").u16be(28).u16be(1).u64be(compressed.length).u64be(toc.length).u32be(1)
    .bytes(compressed);
  for (let index = 0; index < 20; index += 1) out.u8(random.int(256));
  return scatter(out, HEX_WINDOW, random, [
    "com.unknown.payload",
    "postinstall",
    "#!/bin/sh",
    "DO NOT RUN THIS",
    "who left this in Downloads?",
  ], (source) => source.int(256));
}

/** SQLite's variable-length integer, as used in record headers and cell prefixes. */
function varint(value: number): number[] {
  if (value < 0x80) return [value];
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0) {
    bytes.unshift(rest & 0x7f);
    rest = Math.floor(rest / 128);
  }
  return bytes.map((byte, index) => (index < bytes.length - 1 ? byte | 0x80 : byte));
}

/** One table row in SQLite's record format: INTEGER PRIMARY KEY stored as NULL, then text columns. */
function record(values: Array<string | null>): number[] {
  const bodies = values.map((value) => (value === null ? [] : [...utf8(value)]));
  const types = values.flatMap((value, index) => varint(value === null ? 0 : 13 + bodies[index].length * 2));
  const headerLength = types.length + 1;
  return [...varint(headerLength), ...types, ...bodies.flat()];
}

/** A table-leaf b-tree page with cells packed from the end, header at `headerOffset`. */
function leafPage(pageSize: number, headerOffset: number, rows: number[][]): Uint8Array {
  const page = new Uint8Array(pageSize);
  const view = new DataView(page.buffer);
  let contentStart = pageSize;
  const pointers: number[] = [];
  rows.forEach((payload, index) => {
    const cell = [...varint(payload.length), ...varint(index + 1), ...payload];
    contentStart -= cell.length;
    page.set(cell, contentStart);
    pointers.push(contentStart);
  });
  page[headerOffset] = 0x0d;
  view.setUint16(headerOffset + 1, 0);
  view.setUint16(headerOffset + 3, rows.length);
  view.setUint16(headerOffset + 5, contentStart);
  page[headerOffset + 7] = 0;
  pointers.forEach((pointer, index) => view.setUint16(headerOffset + 8 + index * 2, pointer));
  return page;
}

export const GUESTBOOK: Array<[string, string, string]> = [
  ["Webmaster", "1996-02-14", "Welcome to my guestbook! Please sign it and tell me how you found this page."],
  ["cyberkid97", "1996-03-02", "cool site!!! i like the spinning globe. check out my page on geocities"],
  ["Marge", "1996-03-19", "Found you through Yahoo. The page takes a while on my 14.4 but it was worth it."],
  ["anonymous", "1996-04-01", "your under construction sign has been up for six weeks"],
  ["DNeumann", "1996-05-22", "Greetings from the island. The fences are holding. Mostly."],
  ["sysop@bbs", "1996-06-30", "Linked you from the BBS files section. Keep the ASCII art coming."],
  ["Webmaster", "1996-07-04", "Added a MIDI of the theme song. Sorry to everyone at work."],
  ["visitor #1024", "1996-08-11", "Why does your hit counter go backwards after 2 a.m.?"],
];

/**
 * "guestbook.db": a real, openable SQLite 3 database of a 1996 home page's guestbook.
 * Page one is the schema, page two holds the entries.
 */
export function guestbookDatabase(): Uint8Array<ArrayBuffer> {
  const pageSize = 4_096;
  const schema = "CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT, posted TEXT, message TEXT)";
  // Page one's b-tree header sits after the 100-byte file header, which is written over its start.
  const first = leafPage(pageSize, 100, [masterRecord(schema)]);
  const entries = leafPage(pageSize, 0, GUESTBOOK.map(([name, posted, message]) => record([null, name, posted, message])));

  const header = new ByteWriter()
    .text("SQLite format 3").u8(0)
    .u16be(pageSize).u8(1).u8(1).u8(0).u8(64).u8(32).u8(32)
    .u32be(42).u32be(2).u32be(0).u32be(0)
    .u32be(1).u32be(4).u32be(0).u32be(0)
    .u32be(1).u32be(0).u32be(0).u32be(0)
    .zeros(20)
    .u32be(42).u32be(3_045_001)
    .finish();
  first.set(header, 0);

  const file = new Uint8Array(pageSize * 2);
  file.set(first, 0);
  file.set(entries, pageSize);
  return file;
}

/**
 * The schema table's one row. Its `rootpage` column is an integer rather than text,
 * so it is written as serial type 1 (a one-byte integer) pointing at page two.
 */
function masterRecord(schema: string): number[] {
  const texts = ["table", "entries", "entries"].map((value) => [...utf8(value)]);
  const sql = [...utf8(schema)];
  const types = [
    ...texts.flatMap((body) => varint(13 + body.length * 2)),
    1,
    ...varint(13 + sql.length * 2),
  ];
  return [...varint(types.length + 1), ...types, ...texts.flat(), 2, ...sql];
}
