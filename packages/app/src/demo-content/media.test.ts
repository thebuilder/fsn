import { describe, expect, it } from "vitest";
import { crc32 } from "./bytes";
import { ambientLoop, encodeWav, modemHandshake, SAMPLE_RATE } from "./audio";
import { contactSheet, encodePng, PNG_SIGNATURE } from "./png";
import { inflate } from "./testing";

type Chunk = { type: string; data: Uint8Array<ArrayBuffer>; crcValid: boolean };

function pngChunks(bytes: Uint8Array<ArrayBuffer>): Chunk[] {
  const view = new DataView(bytes.buffer);
  const chunks: Chunk[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = view.getUint32(offset);
    const typed = bytes.slice(offset + 4, offset + 8 + length);
    chunks.push({
      type: new TextDecoder().decode(typed.subarray(0, 4)),
      data: typed.slice(4),
      crcValid: crc32(typed) === view.getUint32(offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

function wavHeader(bytes: Uint8Array<ArrayBuffer>) {
  const view = new DataView(bytes.buffer);
  const text = (at: number): string => new TextDecoder().decode(bytes.subarray(at, at + 4));
  return {
    riff: text(0),
    riffSize: view.getUint32(4, true),
    wave: text(8),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    data: text(36),
    dataSize: view.getUint32(40, true),
    samples: new Int16Array(bytes.buffer.slice(44)),
  };
}

describe("PNG encoder", () => {
  it("writes a signature, checksummed chunks and pixel rows a standard inflater accepts", async () => {
    const pixels = new Uint8Array(3 * 2 * 3).fill(200);
    const png = encodePng(3, 2, pixels, { Title: "test" });
    const chunks = pngChunks(png);

    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
    expect(chunks.every((chunk) => chunk.crcValid)).toBe(true);
    const rows = await inflate(chunks[2].data, "deflate");
    // Each row is a filter byte followed by its RGB triplets.
    expect(rows.length).toBe((3 * 3 + 1) * 2);
    expect([...rows.subarray(0, 4)]).toEqual([0, 200, 200, 200]);
  });

  it("refuses a pixel buffer that does not match the stated size", () => {
    expect(() => encodePng(4, 4, new Uint8Array(3))).toThrow();
  });

  it("draws the contact sheet the same way every time", () => {
    const sheet = contactSheet();
    const header = new DataView(pngChunks(sheet)[0].data.buffer);

    expect([header.getUint32(0), header.getUint32(4)]).toEqual([560, 400]);
    expect(contactSheet()).toEqual(sheet);
  });
});

describe("WAV encoder", () => {
  it("writes a 16-bit mono PCM header whose lengths match the samples", () => {
    const wav = wavHeader(encodeWav(new Float32Array([0, 0.5, -0.5, 2])));

    expect(wav).toMatchObject({ riff: "RIFF", riffSize: 36 + 8, wave: "WAVE", format: 1, channels: 1, rate: SAMPLE_RATE, bits: 16, data: "data", dataSize: 8 });
    // Out-of-range input clamps instead of wrapping into a click.
    expect([...wav.samples]).toEqual([0, 16_384, -16_383, 32_767]);
  });

  it("records a few seconds of handshake without clipping", () => {
    const wav = wavHeader(modemHandshake());
    const peak = wav.samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);

    expect(wav.samples.length / SAMPLE_RATE).toBeGreaterThan(5);
    expect(wav.samples.length / SAMPLE_RATE).toBeLessThan(8);
    expect(peak).toBeGreaterThan(8_000);
    expect(peak).toBeLessThan(32_767);
  });

  it("makes an ambient loop whose end runs straight back into its start", () => {
    const { samples } = wavHeader(ambientLoop());
    const typicalStep = Math.abs(samples[1] - samples[0]) + Math.abs(samples[2] - samples[1]);
    const seam = Math.abs(samples[0] - samples[samples.length - 1]);

    expect(samples.length).toBe(8 * SAMPLE_RATE);
    // Crossing the seam should look like any other step between neighbouring samples.
    expect(seam).toBeLessThanOrEqual(typicalStep * 2 + 4);
  });
});
