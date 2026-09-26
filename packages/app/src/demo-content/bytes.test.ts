import { describe, expect, it } from "vitest";
import { adler32, ByteWriter, crc32, seeded, utf8 } from "./bytes";

describe("demo byte helpers", () => {
  it("computes the standard CRC-32 and Adler-32 check values", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(adler32(utf8("Wikipedia"))).toBe(0x11e60398);
  });

  it("repeats a seeded sequence exactly and diverges across seeds", () => {
    const first = seeded(42);
    const again = seeded(42);
    const other = seeded(43);
    const sequence = Array.from({ length: 8 }, () => first.next());

    expect(Array.from({ length: 8 }, () => again.next())).toEqual(sequence);
    expect(Array.from({ length: 8 }, () => other.next())).not.toEqual(sequence);
    expect(sequence.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("keeps every write when an append crosses the buffer's growth boundary", () => {
    const out = new ByteWriter();
    out.zeros(1_022);
    // Each of these straddles the initial 1 KB buffer, so growth happens mid-write.
    out.u32be(0xdeadbeef).bytes(new Uint8Array([1, 2, 3])).u8(9);
    const bytes = out.finish();

    expect(bytes.length).toBe(1_030);
    expect([...bytes.subarray(1_022)]).toEqual([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 9]);
  });

  it("writes integers in the byte order it names", () => {
    const bytes = new ByteWriter().u16le(0x0102).u16be(0x0102).u32le(0x01020304).u64be(5).finish();

    expect([...bytes]).toEqual([2, 1, 1, 2, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 5]);
  });
});
