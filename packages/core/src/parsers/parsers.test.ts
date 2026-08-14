import { describe, expect, it } from "vitest";
import { delimiterFor, parseDelimited } from "./delimited";
import { hexLines, isAnimatedImage } from "./binary";
import { readZipDirectory } from "./zip";

describe("delimited parser", () => {
  it("reads quoted fields, escaped quotes and embedded newlines", () => {
    const sheet = parseDelimited('name,note\n"Smith, D.","said ""go""\nthen left"\nplain,value\n', ",");

    expect(sheet.header).toEqual(["name", "note"]);
    expect(sheet.rows[0]).toEqual(["Smith, D.", 'said "go"\nthen left']);
    expect(sheet.rows[1]).toEqual(["plain", "value"]);
    expect(sheet.totalRows).toBe(2);
    expect(sheet.truncated).toBe(false);
  });

  it("keeps a final row that has no trailing newline", () => {
    expect(parseDelimited("a,b\n1,2", ",").rows).toEqual([["1", "2"]]);
  });

  it("treats CRLF as a single row break", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",").rows).toEqual([["1", "2"]]);
  });

  it("caps returned rows but still reports the full count", () => {
    const sheet = parseDelimited(`h\n${"x\n".repeat(50)}`, ",", 10);

    expect(sheet.rows).toHaveLength(9);
    expect(sheet.totalRows).toBe(50);
    expect(sheet.truncated).toBe(true);
  });

  it("detects the separator from the header row", () => {
    expect(delimiterFor("budget.csv", "a;b;c\n1;2;3")).toBe(";");
    expect(delimiterFor("budget.csv", "a,b,c\n1,2,3")).toBe(",");
    expect(delimiterFor("report.tsv", "a,b,c")).toBe("\t");
    expect(delimiterFor("quoted.csv", '"a;b",c')).toBe(",");
  });

  it("clamps a row wider than maxColumns and flags the clamp", () => {
    const wideRow = ",".repeat(600);
    const sheet = parseDelimited(`h\n${wideRow}\n`, ",");

    expect(sheet.columns).toBe(512);
    expect(sheet.columnsTruncated).toBe(true);
  });

  it("leaves a normal sheet's column count alone", () => {
    const sheet = parseDelimited("a,b,c\n1,2,3\n", ",");

    expect(sheet.columns).toBe(3);
    expect(sheet.columnsTruncated).toBe(false);
  });
});

describe("hex dump", () => {
  it("formats offsets, byte pairs and printable ASCII", () => {
    const [line] = hexLines(new Uint8Array([0x46, 0x53, 0x4e, 0x00]));

    expect(line.offset).toBe("00000000");
    expect(line.hex.trim()).toBe("46 53 4E 00");
    expect(line.ascii).toBe("FSN.");
  });

  it("pads a short final row and continues the offset column", () => {
    const lines = hexLines(new Uint8Array(20), 0x1000);

    expect(lines[0].offset).toBe("00001000");
    expect(lines[1].offset).toBe("00001010");
    expect(lines[1].hex).toHaveLength(lines[0].hex.length);
  });
});

describe("animated image detection", () => {
  const gifHeader = [...Array.from("GIF89a", (char) => char.charCodeAt(0)), 1, 0, 1, 0, 0x00, 0, 0];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x01, 0x00, 0x00];

  it("separates animated from static GIFs", () => {
    expect(isAnimatedImage("gif", new Uint8Array([...gifHeader, ...frame, ...frame, 0x3b]))).toBe(true);
    expect(isAnimatedImage("gif", new Uint8Array([...gifHeader, ...frame, 0x3b]))).toBe(false);
  });

  it("finds the APNG control chunk ahead of the first data chunk", () => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const chunk = (type: string, length = 0) => [0, 0, 0, length, ...Array.from(type, (c) => c.charCodeAt(0)), ...new Array(length + 4).fill(0)];

    expect(isAnimatedImage("png", new Uint8Array([...signature, ...chunk("acTL", 8), ...chunk("IDAT")]))).toBe(true);
    expect(isAnimatedImage("png", new Uint8Array([...signature, ...chunk("IHDR", 13), ...chunk("IDAT")]))).toBe(false);
  });

  it("reads the WebP animation flag", () => {
    const riff = (flags: number) => [
      ...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0,
      ...Array.from("WEBP", (c) => c.charCodeAt(0)),
      ...Array.from("VP8X", (c) => c.charCodeAt(0)), 10, 0, 0, 0,
      flags, ...new Array(9).fill(0),
    ];

    expect(isAnimatedImage("webp", new Uint8Array(riff(0x02)))).toBe(true);
    expect(isAnimatedImage("webp", new Uint8Array(riff(0x00)))).toBe(false);
  });

  it("leaves formats without an animation container alone", () => {
    expect(isAnimatedImage("jpg", new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
  });
});

describe("zip directory", () => {
  const text = (value: string) => Array.from(value, (char) => char.charCodeAt(0));
  const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];

  function centralEntry(name: string, compressed: number, uncompressed: number, method = 8): number[] {
    return [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0x6000), ...u16(0x5921), ...u32(0),
      ...u32(compressed), ...u32(uncompressed),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0),
      ...text(name),
    ];
  }

  function archive(entries: number[][], comment = "", claimedCount = entries.length): Uint8Array {
    const directory = entries.flat();
    return new Uint8Array([
      ...directory,
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(claimedCount), ...u16(claimedCount),
      ...u32(directory.length), ...u32(0), ...u16(comment.length), ...text(comment),
    ]);
  }

  it("lists entries with sizes, methods and totals", () => {
    const zip = readZipDirectory(archive([
      centralEntry("build/", 0, 0, 0),
      centralEntry("build/main.js", 400, 1_000),
    ], "FSN ARCHIVE"));

    expect(zip.entries.map((entry) => entry.name)).toEqual(["build/", "build/main.js"]);
    expect(zip.entries[0].isDirectory).toBe(true);
    expect(zip.entries[1].method).toBe("DEFLATE");
    expect(zip.entries[1].uncompressedSize).toBe(1_000);
    expect(zip.compressedTotal).toBe(400);
    expect(zip.uncompressedTotal).toBe(1_000);
    expect(zip.comment).toBe("FSN ARCHIVE");
  });

  it("decodes the DOS timestamp", () => {
    const [entry] = readZipDirectory(archive([centralEntry("a.txt", 1, 1)])).entries;

    expect(new Date(entry.modified ?? 0).getFullYear()).toBe(2024);
  });

  it("rejects bytes with no central directory", () => {
    expect(() => readZipDirectory(new Uint8Array(64))).toThrow(/central directory/i);
  });

  it("is not truncated when every promised entry is present", () => {
    const zip = readZipDirectory(archive([centralEntry("a.txt", 1, 1), centralEntry("b.txt", 1, 1)]));

    expect(zip.truncated).toBe(false);
    expect(zip.entries).toHaveLength(2);
  });

  it("flags a partial index when the EOCD count exceeds the actual central records", () => {
    const zip = readZipDirectory(archive([centralEntry("a.txt", 1, 1), centralEntry("b.txt", 1, 1)], "", 5));

    expect(zip.truncated).toBe(true);
    expect(zip.entries).toHaveLength(2);
  });
});
