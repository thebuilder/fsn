import { ByteWriter, seeded } from "./bytes";

/** Telephone-grade: a quarter of CD rate keeps a few seconds of sound in a few hundred kilobytes. */
export const SAMPLE_RATE = 22_050;

/** Wraps mono samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const dataLength = samples.length * 2;
  const out = new ByteWriter()
    .text("RIFF").u32le(36 + dataLength).text("WAVE")
    .text("fmt ").u32le(16).u16le(1).u16le(1).u32le(sampleRate).u32le(sampleRate * 2).u16le(2).u16le(16)
    .text("data").u32le(dataLength);
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = Math.round(clamped * 32_767);
    out.u16le(value & 0xffff);
  }
  return out.finish();
}

const TAU = Math.PI * 2;

/** A cursor over a sample buffer that lays sounds end to end, the way a tape does. */
class Tape {
  readonly samples: Float32Array;
  private at = 0;

  constructor(seconds: number) {
    this.samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  }

  /** Writes `seconds` of whatever `voice` returns for each moment, then moves on. */
  play(seconds: number, voice: (t: number) => number): this {
    const count = Math.round(seconds * SAMPLE_RATE);
    // A few milliseconds of ramp at each end, so tones start and stop without clicks.
    const ramp = Math.min(count / 2, SAMPLE_RATE * 0.004);
    for (let index = 0; index < count && this.at < this.samples.length; index += 1) {
      const edge = Math.min(1, index / ramp, (count - index) / ramp);
      this.samples[this.at] += voice(index / SAMPLE_RATE) * edge;
      this.at += 1;
    }
    return this;
  }

  rest(seconds: number): this {
    this.at = Math.min(this.samples.length, this.at + Math.round(seconds * SAMPLE_RATE));
    return this;
  }
}

const DTMF: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "0": [941, 1336],
};

/**
 * "voice-memo.wav": no voice at all, just a modem calling the uplink — dial tone, the
 * number, one ring, the answer tone with its phase flips, the negotiation chirps and
 * the hiss of training. Six and a half seconds, recorded off the phone line.
 */
export function modemHandshake(): Uint8Array<ArrayBuffer> {
  const noise = seeded(0x2400);
  const tape = new Tape(6.6);
  const tone = (...frequencies: number[]) => (t: number): number =>
    frequencies.reduce((sum, frequency) => sum + Math.sin(TAU * frequency * t), 0) / frequencies.length * 0.45;

  tape.play(0.6, tone(350, 440)).rest(0.08);
  for (const digit of "5551996") tape.play(0.09, tone(...DTMF[digit])).rest(0.06);
  tape.rest(0.2).play(0.7, tone(440, 480)).rest(0.35);

  // The answer tone reverses phase every 450 ms, which is what tells echo cancellers to stand down.
  tape.play(1.2, (t) => Math.sin(TAU * 2_100 * t + (Math.floor(t / 0.45) % 2) * Math.PI) * 0.4);

  // V.8 negotiation: frequency-shift keyed bits at 300 baud.
  const bits = Array.from({ length: 150 }, () => noise.int(2));
  let phase = 0;
  tape.play(0.5, (t) => {
    const frequency = bits[Math.floor(t * 300) % bits.length] ? 1_650 : 1_180;
    phase += (TAU * frequency) / SAMPLE_RATE;
    return Math.sin(phase) * 0.35;
  });

  // Training: two carriers under scrambled noise, the part everyone remembers.
  let smooth = 0;
  tape.play(1.6, (t) => {
    smooth = smooth * 0.55 + (noise.next() * 2 - 1) * 0.45;
    const fade = Math.min(1, (1.6 - t) / 0.3);
    return (smooth * 0.5 + Math.sin(TAU * 1_800 * t) * 0.12 + Math.sin(TAU * 2_400 * t) * 0.1) * fade;
  });

  return encodeWav(tape.samples);
}

/**
 * "ambient-loop.wav": an eight-second pad that loops without a seam. Every partial
 * is nudged to a whole number of cycles over the loop, and the slow swells divide it
 * evenly, so the last sample leads straight back into the first.
 */
export function ambientLoop(): Uint8Array<ArrayBuffer> {
  const seconds = 8;
  const loopable = (frequency: number): number => Math.round(frequency * seconds) / seconds;
  // A minor ninth, spread over two octaves, each voice doubled a few cents apart.
  const chord = [110, 164.81, 220, 261.63, 329.63, 493.88].flatMap((root) => [loopable(root), loopable(root * 1.004)]);
  const samples = new Float32Array(seconds * SAMPLE_RATE);
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / SAMPLE_RATE;
    let value = 0;
    for (let voice = 0; voice < chord.length; voice += 1) {
      const swell = 0.6 + 0.4 * Math.sin(TAU * t / (voice % 2 ? 8 : 4) + voice);
      value += Math.sin(TAU * chord[voice] * t) * swell / (1 + voice * 0.35);
    }
    // A slow shimmer an octave up, breathing once per loop.
    value += Math.sin(TAU * loopable(659.26) * t) * 0.08 * (0.5 - 0.5 * Math.cos(TAU * t / seconds));
    samples[index] = value * 0.16;
  }
  return encodeWav(samples);
}
