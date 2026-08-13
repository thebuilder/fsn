export type ZipEntry = {
  name: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  method: string;
  modified?: number;
  encrypted: boolean;
};

export type ZipDirectory = {
  entries: ZipEntry[];
  comment: string;
  compressedTotal: number;
  uncompressedTotal: number;
  /** True when the central directory ended before `entries` reached the count the EOCD promised. */
  truncated: boolean;
};

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL_FILE = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;

const methods = new Map([
  [0, "STORED"], [1, "SHRUNK"], [6, "IMPLODED"], [8, "DEFLATE"], [9, "DEFLATE64"],
  [12, "BZIP2"], [14, "LZMA"], [93, "ZSTD"], [95, "XZ"], [96, "JPEG"], [98, "PPMD"], [99, "AES"],
]);

const decoder = new TextDecoder("utf-8");

/**
 * Reads a ZIP central directory without inflating anything. Listing an archive only
 * needs the trailing index, so this stays cheap even on a multi-gigabyte file, and
 * it keeps the viewer dependency-free.
 *
 * `bytes` may be a window onto the end of the file; `baseOffset` says where that
 * window starts, since every offset stored in a ZIP is absolute.
 */
export function readZipDirectory(bytes: Uint8Array, baseOffset = 0): ZipDirectory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("No ZIP central directory found; the archive is truncated or not a ZIP.");

  let count = view.getUint16(eocd + 10, true);
  let start = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  const comment = commentLength ? decoder.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLength)) : "";

  // ZIP64 archives park the real counts in a separate record ahead of the locator.
  if (count === 0xffff || start === ZIP64_SENTINEL) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === EOCD64_LOCATOR) {
      const record = Number(view.getBigUint64(locator + 8, true)) - baseOffset;
      if (record >= 0 && record + 56 <= view.byteLength && view.getUint32(record, true) === EOCD64) {
        count = Number(view.getBigUint64(record + 32, true));
        start = Number(view.getBigUint64(record + 48, true));
      }
    }
  }

  const entries: ZipEntry[] = [];
  let offset = start - baseOffset;
  if (offset < 0) throw new Error("The archive index sits outside the readable window.");
  let compressedTotal = 0;
  let uncompressedTotal = 0;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE) break;
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentSize = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const sizes = readSizes(view, offset, bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));

    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      compressedSize: sizes.compressed,
      uncompressedSize: sizes.uncompressed,
      method: methods.get(view.getUint16(offset + 10, true)) ?? `M${view.getUint16(offset + 10, true)}`,
      modified: dosTimestamp(view.getUint16(offset + 14, true), view.getUint16(offset + 12, true)),
      encrypted: (flags & 0x0001) !== 0,
    });
    compressedTotal += sizes.compressed;
    uncompressedTotal += sizes.uncompressed;
    offset += 46 + nameLength + extraLength + commentSize;
  }

  return { entries, comment, compressedTotal, uncompressedTotal, truncated: entries.length < count };
}

/** The EOCD sits at the end but may trail up to 64 KB of archive comment. */
function findEndOfCentralDirectory(view: DataView): number {
  const limit = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD) return offset;
  }
  return -1;
}

function readSizes(view: DataView, entry: number, extra: Uint8Array): { compressed: number; uncompressed: number } {
  const uncompressed = view.getUint32(entry + 24, true);
  const compressed = view.getUint32(entry + 20, true);
  if (uncompressed !== ZIP64_SENTINEL && compressed !== ZIP64_SENTINEL) return { compressed, uncompressed };

  const extraView = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let offset = 0; offset + 4 <= extra.byteLength; ) {
    const id = extraView.getUint16(offset, true);
    const size = extraView.getUint16(offset + 2, true);
    if (id === 0x0001) {
      // Zip64 extended information: only the fields that overflowed are present, in order.
      let cursor = offset + 4;
      const real = { compressed, uncompressed };
      if (uncompressed === ZIP64_SENTINEL && cursor + 8 <= extra.byteLength) {
        real.uncompressed = Number(extraView.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (compressed === ZIP64_SENTINEL && cursor + 8 <= extra.byteLength) {
        real.compressed = Number(extraView.getBigUint64(cursor, true));
      }
      return real;
    }
    offset += 4 + size;
  }
  return { compressed, uncompressed };
}

function dosTimestamp(date: number, time: number): number | undefined {
  if (!date) return undefined;
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  return new Date(year, month, day, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
}
