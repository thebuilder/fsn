import { adler32 } from "./bytes";

/**
 * A small DEFLATE compressor: LZ77 over a 32 KB window, coded with the fixed Huffman
 * tables from RFC 1951.
 *
 * The demo archives and images are built in the page, synchronously and on first
 * read, so the browser's own `CompressionStream` (asynchronous, and absent from older
 * WebViews) does not fit. Fixed codes compress noticeably worse than zlib's dynamic
 * ones, but well enough that an archive manifest shows honest savings and a generated
 * picture stays a few hundred kilobytes rather than a raw bitmap.
 */

const WINDOW = 32_768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
/** How many earlier candidates a position will try; enough for text, bounded for noise. */
const MAX_CHAIN = 48;
const HASH_BITS = 15;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** Least-significant-bit-first writer, the order DEFLATE packs everything but Huffman codes in. */
class BitWriter {
  private bytes = new Uint8Array(4_096);
  private length = 0;
  private accumulator = 0;
  private count = 0;

  bits(value: number, width: number): void {
    this.accumulator |= value << this.count;
    this.count += width;
    while (this.count >= 8) {
      this.push(this.accumulator & 0xff);
      this.accumulator >>>= 8;
      this.count -= 8;
    }
  }

  /** Huffman codes are defined most-significant bit first, so they go in reversed. */
  code(value: number, width: number): void {
    let reversed = 0;
    for (let bit = 0; bit < width; bit += 1) reversed |= ((value >> bit) & 1) << (width - 1 - bit);
    this.bits(reversed, width);
  }

  finish(): Uint8Array<ArrayBuffer> {
    if (this.count > 0) this.push(this.accumulator & 0xff);
    this.accumulator = 0;
    this.count = 0;
    return this.bytes.slice(0, this.length);
  }

  private push(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length] = byte;
    this.length += 1;
  }
}

function writeLiteral(out: BitWriter, symbol: number): void {
  if (symbol < 144) out.code(0x30 + symbol, 8);
  else if (symbol < 256) out.code(0x190 + symbol - 144, 9);
  else if (symbol < 280) out.code(symbol - 256, 7);
  else out.code(0xc0 + symbol - 280, 8);
}

function writeMatch(out: BitWriter, length: number, distance: number): void {
  let lengthCode = LENGTH_BASE.length - 1;
  while (LENGTH_BASE[lengthCode] > length) lengthCode -= 1;
  writeLiteral(out, 257 + lengthCode);
  if (LENGTH_EXTRA[lengthCode]) out.bits(length - LENGTH_BASE[lengthCode], LENGTH_EXTRA[lengthCode]);

  let distanceCode = DISTANCE_BASE.length - 1;
  while (DISTANCE_BASE[distanceCode] > distance) distanceCode -= 1;
  out.code(distanceCode, 5);
  if (DISTANCE_EXTRA[distanceCode]) out.bits(distance - DISTANCE_BASE[distanceCode], DISTANCE_EXTRA[distanceCode]);
}

const hashAt = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 10) ^ (bytes[at + 1] << 5) ^ bytes[at + 2]) & ((1 << HASH_BITS) - 1);

/** A raw DEFLATE stream (no zlib or gzip wrapper), as ZIP stores it. */
export function deflateRaw(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new BitWriter();
  // One final block with fixed codes: BFINAL = 1, BTYPE = 01.
  out.bits(1, 1);
  out.bits(1, 2);

  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const previous = new Int32Array(WINDOW).fill(-1);
  const insert = (at: number): void => {
    if (at + MIN_MATCH > input.length) return;
    const hash = hashAt(input, at);
    previous[at % WINDOW] = head[hash];
    head[hash] = at;
  };

  let position = 0;
  while (position < input.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (position + MIN_MATCH <= input.length) {
      let candidate = head[hashAt(input, position)];
      const limit = Math.min(MAX_MATCH, input.length - position);
      for (let chain = 0; candidate >= 0 && chain < MAX_CHAIN; chain += 1) {
        const distance = position - candidate;
        if (distance > WINDOW - 1) break;
        let length = 0;
        while (length < limit && input[candidate + length] === input[position + length]) length += 1;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = distance;
          if (length === limit) break;
        }
        candidate = previous[candidate % WINDOW];
      }
    }

    if (bestLength >= MIN_MATCH) {
      writeMatch(out, bestLength, bestDistance);
      for (let offset = 0; offset < bestLength; offset += 1) insert(position + offset);
      position += bestLength;
    } else {
      writeLiteral(out, input[position]);
      insert(position);
      position += 1;
    }
  }

  writeLiteral(out, 256);
  return out.finish();
}

/** A zlib stream: the two-byte header, raw DEFLATE, then the Adler-32 of the input. PNG uses this. */
export function deflateZlib(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = deflateRaw(input);
  const output = new Uint8Array(body.length + 6);
  // CMF 0x78: DEFLATE with a 32 KB window. FLG 0x01 makes the pair a multiple of 31.
  output[0] = 0x78;
  output[1] = 0x01;
  output.set(body, 2);
  const checksum = adler32(input);
  new DataView(output.buffer).setUint32(output.length - 4, checksum, false);
  return output;
}
