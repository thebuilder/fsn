import { describe, expect, it } from "vitest";
import { hexLines } from "@fsn/core/parsers/binary";
import {
  classifiedData,
  GUESTBOOK,
  guestbookDatabase,
  HEX_WINDOW,
  pefApplication,
  resourceFile,
  telemetryFrames,
  unknownPackage,
} from "./binaries";
import { crc32 } from "./bytes";
import { inflate } from "./testing";

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
/** What an operator sees in the hex monitor's right-hand column, joined into one string. */
const dumpText = (bytes: Uint8Array): string => hexLines(bytes).map((line) => line.ascii).join("");

describe("locked demo binaries", () => {
  it("opens an application with the PEF container's magic and hides its strings in the dump", () => {
    const app = pefApplication("HyperCard", ["Please locate Home."], 1);

    expect(ascii(app.subarray(0, 12))).toBe("Joy!peffpwpc");
    expect(app.length).toBe(HEX_WINDOW);
    expect(ascii(app)).toContain("Please locate Home.");
  });

  it("interleaves resource types with the strings in a resource file", () => {
    const file = resourceFile(["STR#"], ["Welcome to Macintosh."], 2);

    expect(new DataView(file.buffer).getUint32(0)).toBe(256);
    expect(ascii(file)).toContain("STR#");
    expect(ascii(file)).toContain("Welcome to Macintosh.");
  });

  it("leaves one plain-text confession in the sealed container", () => {
    const sealed = classifiedData();

    expect(ascii(sealed.subarray(0, 10))).toBe("FSN/SEALED");
    expect(dumpText(sealed)).toContain("IF YOU CAN READ THIS, THE HEX DUMP WORKS.");
  });

  it("frames telemetry every 256 bytes behind the CCSDS sync marker", () => {
    const frames = telemetryFrames();
    const view = new DataView(frames.buffer);

    for (let offset = 0; offset < frames.length; offset += 256) {
      expect(view.getUint32(offset)).toBe(0x1acffc1d);
      expect(view.getUint16(offset + 6)).toBe(offset / 256);
    }
    expect(dumpText(frames)).toContain("UNKNOWN CARRIER 1420.405 MHZ");
  });

  it("builds a xar package whose table of contents really inflates", async () => {
    const pkg = unknownPackage();
    const view = new DataView(pkg.buffer);
    const compressed = Number(view.getBigUint64(8));
    const expanded = Number(view.getBigUint64(16));
    const toc = await inflate(pkg.slice(28, 28 + compressed), "deflate");

    expect(ascii(pkg.subarray(0, 4))).toBe("xar!");
    expect(view.getUint16(4)).toBe(28);
    expect(toc.length).toBe(expanded);
    expect(new TextDecoder().decode(toc)).toContain("<name>Payload</name>");
  });

  it("writes a SQLite 3 file with the schema on page one and the guestbook on page two", () => {
    const database = guestbookDatabase();
    const view = new DataView(database.buffer);
    const pageSize = view.getUint16(16);

    expect(ascii(database.subarray(0, 16))).toBe("SQLite format 3\0");
    expect(view.getUint32(28)).toBe(database.length / pageSize);
    // Page one is a table leaf (0x0D) after the file header; page two holds one cell per entry.
    expect(database[100]).toBe(0x0d);
    expect(database[pageSize]).toBe(0x0d);
    expect(view.getUint16(pageSize + 3)).toBe(GUESTBOOK.length);
    expect(ascii(database)).toContain("CREATE TABLE entries");
    expect(ascii(database)).toContain("visitor #1024");
  });

  // Generous timeout: generating each file twice is real work, and CI runs every
  // package's tests at once on a couple of cores.
  it("generates identical bytes on every run", { timeout: 20_000 }, () => {
    for (const make of [telemetryFrames, unknownPackage, guestbookDatabase]) {
      const first = make();
      const second = make();
      // By length and checksum, since a deep equality walk over 64 KB is itself slow.
      expect([second.length, crc32(second)]).toEqual([first.length, crc32(first)]);
    }
  });
});
