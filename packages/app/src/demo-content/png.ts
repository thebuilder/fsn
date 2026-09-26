import { ByteWriter, crc32, seeded, utf8 } from "./bytes";
import { deflateZlib } from "./deflate";

/** PNG's eight-byte signature: a high bit, the name, and line endings that catch bad transfers. */
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(out: ByteWriter, type: string, data: Uint8Array): void {
  const typed = new Uint8Array(4 + data.length);
  typed.set(utf8(type));
  typed.set(data, 4);
  out.u32be(data.length).bytes(typed).u32be(crc32(typed));
}

/** Encodes 8-bit RGB pixels, row-major, as a truecolour PNG with no row filters. */
export function encodePng(width: number, height: number, rgb: Uint8Array, text: Record<string, string> = {}): Uint8Array<ArrayBuffer> {
  if (rgb.length !== width * height * 3) throw new Error("Pixel buffer does not match the image size.");
  const header = new ByteWriter().u32be(width).u32be(height).u8(8).u8(2).u8(0).u8(0).u8(0).finish();

  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    // Filter type 0 per row. Our pictures are flat colour and hard edges, which LZ77
    // already finds; the predictive filters would buy little for the extra code.
    raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const out = new ByteWriter().bytes(new Uint8Array(PNG_SIGNATURE));
  chunk(out, "IHDR", header);
  for (const [key, value] of Object.entries(text)) chunk(out, "tEXt", utf8(`${key}\0${value}`));
  chunk(out, "IDAT", deflateZlib(raw));
  chunk(out, "IEND", new Uint8Array());
  return out.finish();
}

type Rgb = [number, number, number];
/** A frame is drawn like a fragment shader: normalised coordinates in, a colour out. */
type Shader = (u: number, v: number, noise: number) => Rgb;

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const fract = (value: number): number => value - Math.floor(value);
const hash = (x: number, y: number): number => fract(Math.sin(x * 127.1 + y * 311.7) * 43_758.545_3);

/** Twelve exposures from one roll: the places and screens the rest of the demo talks about. */
const FRAMES: Shader[] = [
  // Sunset over the grid: banded sun, perspective floor.
  (u, v) => {
    if (v > 0.62) {
      const depth = 1 / (v - 0.6);
      const line = fract(depth * 1.4) < 0.08 || fract((u - 0.5) * depth * 1.6) < 0.06;
      return line ? [255, 60, 170] : [18, 4, 40];
    }
    const sun = Math.hypot(u - 0.5, (v - 0.46) * 1.3);
    if (sun < 0.24 && !(v > 0.44 && fract(v * 28) < 0.3)) return mix([255, 230, 90], [255, 70, 140], (v - 0.22) / 0.4);
    return mix([30, 10, 70], [255, 90, 120], v / 0.62);
  },
  // Deep field.
  (u, v, noise) => {
    const star = noise > 0.985 ? 255 * noise : 0;
    const nebula = Math.max(0, Math.sin(u * 5 + v * 3) * Math.cos(v * 7 - u * 2)) * 60;
    return [star + nebula * 0.6, star + nebula * 0.2, star + nebula + 18];
  },
  // The city: a skyline of lit towers, which is what FSN draws.
  (u, v, noise) => {
    const column = Math.floor(u * 11);
    const top = 0.25 + hash(column, 3) * 0.5;
    if (v < top) return mix([6, 10, 30], [40, 20, 70], v);
    const lit = fract(u * 11) > 0.2 && fract(u * 11) < 0.8 && fract(v * 30) > 0.45 && noise > 0.35;
    return lit ? [114, 247, 212] : [12, 26, 34];
  },
  // Plasma.
  (u, v) => {
    const t = Math.sin(u * 10) + Math.sin(v * 12 + u * 4) + Math.sin(Math.hypot(u - 0.5, v - 0.5) * 22);
    return [128 + 127 * Math.sin(t * 1.4), 128 + 127 * Math.sin(t * 1.4 + 2.1), 128 + 127 * Math.sin(t * 1.4 + 4.2)];
  },
  // Mountain pass at dusk.
  (u, v) => {
    const ridge = 0.55 - 0.18 * Math.sin(u * 7.3) * Math.cos(u * 3.1) - 0.08 * Math.sin(u * 23);
    const near = 0.78 - 0.1 * Math.sin(u * 4.4 + 1);
    if (v > near) return [10, 8, 18];
    if (v > ridge) return [40, 30, 70];
    return mix([250, 170, 110], [70, 60, 140], 1 - v / ridge);
  },
  // A terminal, mid-scroll.
  (u, v, noise) => {
    const row = Math.floor(v * 16);
    const length = 0.2 + hash(row, 9) * 0.7;
    const glyph = u > 0.08 && u < length && fract(v * 16) > 0.3 && fract(u * 40) > 0.25 && noise > 0.25;
    const scan = 0.85 + 0.15 * Math.sin(v * 220);
    return glyph ? [60 * scan, 255 * scan, 140 * scan] : [4, 22 * scan, 12];
  },
  // Radar sweep.
  (u, v) => {
    const x = u - 0.5;
    const y = v - 0.5;
    const radius = Math.hypot(x, y);
    if (radius > 0.46) return [8, 12, 10];
    const angle = fract(Math.atan2(y, x) / (Math.PI * 2) + 0.25);
    const ring = fract(radius * 10) < 0.06 ? 60 : 0;
    const blip = Math.hypot(x - 0.12, y + 0.18) < 0.02 ? 255 : 0;
    return [blip, 40 + angle * 200 + ring + blip, 30 + ring];
  },
  // Moiré.
  (u, v) => {
    const a = Math.sin(Math.hypot(u - 0.3, v - 0.4) * 140);
    const b = Math.sin(Math.hypot(u - 0.7, v - 0.6) * 140);
    const value = a * b > 0 ? 230 : 25;
    return [value, value, value * 0.95];
  },
  // Neon coast under a moon.
  (u, v) => {
    const moon = Math.hypot(u - 0.7, v - 0.25) < 0.09;
    if (v < 0.55) return moon ? [240, 240, 220] : mix([10, 10, 40], [80, 20, 90], v / 0.55);
    const glint = Math.abs(u - 0.7) < 0.05 * (v - 0.4) * 3 && fract(v * 40) > 0.5;
    return glint ? [220, 220, 200] : mix([20, 30, 80], [5, 5, 20], (v - 0.55) / 0.45);
  },
  // Survey contours.
  (u, v) => {
    const height = Math.sin(u * 6) * Math.cos(v * 5) + 0.5 * Math.sin(u * 13 + v * 9);
    const contour = fract(height * 5) < 0.12;
    return contour ? [200, 120, 40] : [236, 226, 200];
  },
  // Light leak: the end of the roll.
  (u, _v, noise) => {
    const leak = Math.max(0, 1 - u * 1.4) ** 2;
    return [40 + 215 * leak + noise * 12, 20 + 120 * leak + noise * 12, 10 + 30 * leak + noise * 12];
  },
  // Test card.
  (u, v) => {
    const bars: Rgb[] = [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0], [192, 0, 192], [192, 0, 0], [0, 0, 192]];
    if (v < 0.7) return bars[Math.min(6, Math.floor(u * 7))];
    if (v < 0.78) return bars[6 - Math.min(6, Math.floor(u * 7))].map((c) => c * 0.4) as Rgb;
    return u < 0.6 ? [16, 16, 16] : [235, 235, 235];
  },
];

/** A 3×5 bitmap face, just wide enough for frame numbers and the edge print. */
const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001111", "F": "111100110100100", "S": "111100111001111",
  "N": "111101101101101", "M": "101111111101101", "H": "101101111101101", "K": "101110100110101", "R": "110101110101101", "O": "111101101101111",
  "L": "100100100100111", "A": "010101111101101", "E": "111100110100111", "T": "111010010010010",
  " ": "000000000000000", "/": "001001010100100", "-": "000000111000000", "Y": "101101010010010",
  "P": "111101111100100", "X": "101101010101101", "I": "111010010010111", "C": "111100100100111",
};

/**
 * A contact sheet: three strips of four frames on a film-base background, with
 * sprocket holes and edge print. It replaces a TIFF that no browser could decode.
 */
export function contactSheet(): Uint8Array<ArrayBuffer> {
  const width = 560;
  const height = 400;
  const pixels = new Uint8Array(width * height * 3);
  const put = (x: number, y: number, color: Rgb): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 3;
    pixels[at] = clamp(color[0]);
    pixels[at + 1] = clamp(color[1]);
    pixels[at + 2] = clamp(color[2]);
  };
  const text = (label: string, x: number, y: number, color: Rgb, scale = 1): void => {
    [...label].forEach((character, index) => {
      const glyph = GLYPHS[character] ?? GLYPHS[" "];
      for (let cell = 0; cell < 15; cell += 1) {
        if (glyph[cell] !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) put(x + index * 4 * scale + (cell % 3) * scale + dx, y + Math.floor(cell / 3) * scale + dy, color);
        }
      }
    });
  };

  const grain = seeded(0x5ea5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) put(x, y, [28 + grain.int(6), 22 + grain.int(5), 18 + grain.int(4)]);
  }

  const frameWidth = 120;
  const frameHeight = 80;
  const stripHeight = 124;
  for (let strip = 0; strip < 3; strip += 1) {
    const top = 14 + strip * stripHeight;
    for (let x = 12; x < width - 12; x += 1) {
      for (let y = top; y < top + stripHeight - 10; y += 1) put(x, y, [44, 30, 20]);
    }
    // Sprocket holes run along both edges of every strip.
    for (let hole = 20; hole < width - 24; hole += 16) {
      for (let y = 0; y < 6; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          put(hole + x, top + 4 + y, [230, 225, 210]);
          put(hole + x, top + stripHeight - 20 + y, [230, 225, 210]);
        }
      }
    }
    for (let column = 0; column < 4; column += 1) {
      const index = strip * 4 + column;
      const left = 28 + column * (frameWidth + 12);
      const frameTop = top + 16;
      const shader = FRAMES[index];
      const noise = seeded(index + 1);
      for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
          // Corners are rounded a little, the way a real frame's gate masks them.
          const cornerX = Math.min(x, frameWidth - 1 - x);
          const cornerY = Math.min(y, frameHeight - 1 - y);
          if (cornerX + cornerY < 2) continue;
          put(left + x, frameTop + y, shader(x / frameWidth, y / frameHeight, noise.next()));
        }
      }
      text(String(index + 1).padStart(2, "0"), left, frameTop + frameHeight + 3, [240, 170, 60]);
    }
    text("FSN-400 SAFETY FILM", width - 94, top + 99, [240, 170, 60]);
  }
  text("ROLL 07 / CONTACT SHEET", 14, height - 10, [210, 200, 180]);

  return encodePng(width, height, pixels, { Title: "Contact sheet, roll 07", Software: "FSN darkroom" });
}
