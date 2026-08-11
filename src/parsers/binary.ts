export type HexLine = { offset: string; hex: string; ascii: string };

const HEX = "0123456789ABCDEF";

/** Classic 16-column dump: offset, hex pairs split into two groups of eight, printable ASCII. */
export function hexLines(bytes: Uint8Array, start = 0): HexLine[] {
  const lines: HexLine[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const cells: string[] = [];
    let ascii = "";
    for (let index = 0; index < 16; index += 1) {
      const byte = row[index];
      // Short final rows keep their blanks: the columns must not shift under the gutter.
      cells.push(index < row.length ? `${HEX[byte >> 4]}${HEX[byte & 0x0f]}` : "  ");
      if (index < row.length) ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    }
    lines.push({
      offset: (start + offset).toString(16).toUpperCase().padStart(8, "0"),
      hex: `${cells.slice(0, 8).join(" ")}  ${cells.slice(8).join(" ")}`,
      ascii,
    });
  }
  return lines;
}

/**
 * True when the bytes hold more than one frame. Canvas rasterisation freezes an
 * animation on its first frame, so the image viewer needs to know before it decides
 * how to present the file — and a *static* GIF should still get the real filter.
 */
export function isAnimatedImage(extension: string, bytes: Uint8Array): boolean {
  if (extension === "gif") return gifIsAnimated(bytes);
  if (extension === "png" || extension === "apng") return pngIsAnimated(bytes);
  if (extension === "webp") return webpIsAnimated(bytes);
  return false;
}

function matches(bytes: Uint8Array, offset: number, signature: string): boolean {
  if (offset + signature.length > bytes.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false;
  }
  return true;
}

/** Walks the GIF block structure and stops as soon as a second image descriptor appears. */
function gifIsAnimated(bytes: Uint8Array): boolean {
  if (!matches(bytes, 0, "GIF")) return false;
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);

  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x3b) break;
    if (block === 0x21) {
      offset = skipSubBlocks(bytes, offset + 2);
      continue;
    }
    if (block !== 0x2c) break;
    frames += 1;
    if (frames > 1) return true;
    const local = bytes[offset + 9];
    offset += 10;
    if (local & 0x80) offset += 3 * 2 ** ((local & 0x07) + 1);
    offset = skipSubBlocks(bytes, offset + 1);
  }
  return false;
}

/** GIF payloads are chains of length-prefixed chunks closed by a zero-length block. */
function skipSubBlocks(bytes: Uint8Array, offset: number): number {
  let cursor = offset;
  while (cursor < bytes.length) {
    const length = bytes[cursor];
    if (!length) return cursor + 1;
    cursor += length + 1;
  }
  return bytes.length;
}

function pngIsAnimated(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || bytes[0] !== 0x89 || !matches(bytes, 1, "PNG")) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    if (matches(bytes, offset + 4, "acTL")) return true;
    if (matches(bytes, offset + 4, "IDAT")) return false;
    offset += 12 + view.getUint32(offset, false);
  }
  return false;
}

function webpIsAnimated(bytes: Uint8Array): boolean {
  if (!matches(bytes, 0, "RIFF") || !matches(bytes, 8, "WEBP")) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    if (matches(bytes, offset, "ANMF")) return true;
    // VP8X carries the feature flags; bit 1 marks the file as animated.
    if (matches(bytes, offset, "VP8X")) return (bytes[offset + 8] & 0x02) !== 0;
    offset += 8 + size + (size % 2);
  }
  return false;
}
