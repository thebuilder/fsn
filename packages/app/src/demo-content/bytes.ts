/**
 * Byte-level building blocks shared by the demo content generators.
 *
 * Every generator in this folder has to produce the same bytes on every run: the demo
 * is a fixed place, and a file that changed its contents between visits would read as
 * a bug rather than as atmosphere. So nothing here consults the clock or `Math.random`;
 * randomness comes from a seeded generator and dates are written out as literals.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * One raw step of the CRC-32 register, without the pre- and post-inversion. ZIP's
 * traditional encryption keys its cipher off this exact step, so it is exposed on its
 * own rather than folded into `crc32`.
 */
export function crc32Step(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

/** The CRC-32 used by ZIP and PNG. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = crc32Step(crc, byte);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The Adler-32 trailer zlib puts after a deflate stream. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/**
 * A seeded Mulberry32 stream. It is small, fast and plenty random for noise, star
 * fields and log chatter, and — the point — it gives the same sequence for a seed.
 */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (limit) => Math.floor(next() * limit),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (probability) => next() < probability,
  };
}

export type Random = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, limit). */
  int(limit: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
};

/**
 * An append-only byte buffer with the handful of integer encodings binary formats
 * need. It grows by doubling, so writers never have to predict their final size.
 */
export class ByteWriter {
  private buffer = new Uint8Array(1_024);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  /**
   * Makes room for `count` more bytes and returns where they start. Callers must take
   * the offset before touching `buffer` or `view`: growing replaces both, so an
   * expression that read `this.buffer` first would write into the discarded one.
   */
  private reserve(count: number): number {
    const at = this.length;
    const needed = at + count;
    if (needed > this.buffer.length) {
      let size = this.buffer.length;
      while (size < needed) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.buffer.subarray(0, at));
      this.buffer = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = needed;
    return at;
  }

  u8(value: number): this {
    const at = this.reserve(1);
    this.buffer[at] = value & 0xff;
    return this;
  }

  u16le(value: number): this {
    const at = this.reserve(2);
    this.view.setUint16(at, value, true);
    return this;
  }

  u16be(value: number): this {
    const at = this.reserve(2);
    this.view.setUint16(at, value, false);
    return this;
  }

  u32le(value: number): this {
    const at = this.reserve(4);
    this.view.setUint32(at, value >>> 0, true);
    return this;
  }

  u32be(value: number): this {
    const at = this.reserve(4);
    this.view.setUint32(at, value >>> 0, false);
    return this;
  }

  u64be(value: number): this {
    const at = this.reserve(8);
    this.view.setBigUint64(at, BigInt(value), false);
    return this;
  }

  bytes(bytes: Uint8Array): this {
    const at = this.reserve(bytes.length);
    this.buffer.set(bytes, at);
    return this;
  }

  /** Writes text as UTF-8; formats that need a fixed-width field pad it with `pad`. */
  text(text: string, pad?: number): this {
    const encoded = utf8(text);
    this.bytes(encoded);
    if (pad !== undefined) this.zeros(Math.max(0, pad - encoded.length));
    return this;
  }

  zeros(count: number): this {
    this.reserve(count);
    return this;
  }

  /** Overwrites four bytes already written, for headers whose lengths are known only later. */
  patchU32le(at: number, value: number): this {
    this.view.setUint32(at, value >>> 0, true);
    return this;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length);
  }
}
