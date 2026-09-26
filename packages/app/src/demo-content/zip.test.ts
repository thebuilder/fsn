import { describe, expect, it } from "vitest";
import { readZipDirectory } from "@fsn/core/parsers/zip";
import { crc32, crc32Step, utf8 } from "./bytes";
import { archiveZip, buildOutputZip } from "./archives";
import { inflate } from "./testing";
import { makeZip } from "./zip";

const MOMENT = { year: 1996, month: 8, day: 11, hour: 2, minute: 14 };

/** Reads one entry back through its local header, the way an extractor would. */
async function extract(archive: Uint8Array<ArrayBuffer>, offset: number, password?: string): Promise<Uint8Array> {
  const view = new DataView(archive.buffer);
  expect(view.getUint32(offset, true)).toBe(0x04034b50);
  const method = view.getUint16(offset + 8, true);
  const crc = view.getUint32(offset + 14, true);
  const packedSize = view.getUint32(offset + 18, true);
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  let packed = archive.slice(start, start + packedSize);
  if (password) packed = decrypt(packed, password, crc);
  const plain = method === 8 ? await inflate(packed, "deflate-raw") : packed;
  expect(crc32(plain)).toBe(crc);
  return plain;
}

/** The inverse of ZipCrypto, written from the APPNOTE rather than shared with the encoder. */
function decrypt(sealed: Uint8Array, password: string, crc: number): Uint8Array<ArrayBuffer> {
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const update = (byte: number): void => {
    k0 = crc32Step(k0, byte);
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134_775_813) + 1) >>> 0;
    k2 = crc32Step(k2, k1 >>> 24);
  };
  for (const byte of utf8(password)) update(byte);
  const plain = new Uint8Array(sealed.length);
  sealed.forEach((byte, index) => {
    const temp = (k2 | 2) & 0xffff;
    plain[index] = byte ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff);
    update(plain[index]);
  });
  // The last header byte is the password check: the top byte of the entry's CRC.
  expect(plain[11]).toBe(crc >>> 24);
  return plain.slice(12);
}

describe("zip writer", () => {
  it("writes an index that core's archive reader lists entry for entry", () => {
    const archive = makeZip([
      { name: "docs/", modified: MOMENT },
      { name: "docs/readme.txt", modified: MOMENT, data: "hello ".repeat(100) },
      { name: "docs/raw.bin", modified: MOMENT, data: new Uint8Array([1, 2, 3]), store: true },
    ], "a comment");
    const directory = readZipDirectory(archive);

    expect(directory.comment).toBe("a comment");
    expect(directory.truncated).toBe(false);
    expect(directory.entries.map((entry) => [entry.name, entry.isDirectory, entry.method, entry.uncompressedSize])).toEqual([
      ["docs/", true, "STORED", 0],
      ["docs/readme.txt", false, "DEFLATE", 600],
      ["docs/raw.bin", false, "STORED", 3],
    ]);
    expect(directory.entries[1].compressedSize).toBeLessThan(600);
    expect(new Date(directory.entries[1].modified!).getFullYear()).toBe(1996);
  });

  it("stores bytes an extractor can get back, CRC and all", async () => {
    const archive = makeZip([
      { name: "a.txt", modified: MOMENT, data: "first" },
      { name: "b.txt", modified: MOMENT, data: "second ".repeat(50) },
    ]);
    const second = 30 + "a.txt".length + new DataView(archive.buffer).getUint32(18, true);

    expect(new TextDecoder().decode(await extract(archive, 0))).toBe("first");
    expect(new TextDecoder().decode(await extract(archive, second))).toBe("second ".repeat(50));
  });

  it("seals a password-protected entry so only the password opens it", async () => {
    const archive = makeZip([{ name: "vault.txt", modified: MOMENT, data: "west platform", password: "velociraptor" }]);
    const [entry] = readZipDirectory(archive).entries;

    expect(entry.encrypted).toBe(true);
    expect(new TextDecoder().decode(await extract(archive, 0, "velociraptor"))).toBe("west platform");
  });
});

describe("demo archives", () => {
  it("lists the build output as a bundler would leave it", () => {
    const directory = readZipDirectory(buildOutputZip());
    const names = directory.entries.map((entry) => entry.name);

    expect(names).toContain("dist/index.html");
    expect(names).toContain("dist/assets/navigator-3f9a1c.js");
    expect(directory.entries.find((entry) => entry.name.endsWith(".png"))?.method).toBe("STORED");
    expect(directory.compressedTotal).toBeLessThan(directory.uncompressedTotal);
  });

  it("ships the tape archive with its reels and one sealed vault entry", async () => {
    const archive = archiveZip();
    const directory = readZipDirectory(archive);
    const sealed = directory.entries.filter((entry) => entry.encrypted);

    expect(directory.entries.filter((entry) => entry.name.includes("/tapes/reel-"))).toHaveLength(4);
    expect(sealed.map((entry) => entry.name)).toEqual(["ARCHIVE-001/vault/coordinates.txt"]);
    expect(directory.comment).toContain("RECOVERED FROM TAPE");
  });

  it("generates identical bytes on every run", () => {
    expect(buildOutputZip()).toEqual(buildOutputZip());
    expect(archiveZip()).toEqual(archiveZip());
  });
});
