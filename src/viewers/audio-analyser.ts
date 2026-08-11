import type { Signal } from "./visualizers/types";

/** 1024 samples → 512 bins, ~43 Hz each: enough resolution to separate a kick from a bassline. */
const FFT_SIZE = 1024;
/** Frames of bass energy kept for onset detection — roughly the last second. */
const HISTORY = 56;
/**
 * Frames of level required before any onset counts. Starting playback takes the low
 * end from silence to full in one frame, which beats every ratio test there is — that
 * false onset is the wave that slams across the screen the instant you press play.
 */
const WARMUP = 14;
/** How far above the running average a frame must sit to count as an onset. */
const ONSET_RATIO = 1.32;
/** Minimum gap between onsets, in seconds; below this a single kick fires twice. */
const ONSET_GAP = 0.11;
/** Per-second decay of the beat pulse. */
const BEAT_DECAY = 6.5;

export type OnsetDetector = {
  /** Feeds one frame of low-end energy and returns the current pulse, 1 on an onset. */
  push(bass: number, elapsed: number, delta: number, playing: boolean): number;
};

/**
 * Energy-based onset detection: a frame counts as a beat when its low end sits well
 * above the running average of the last second. Spectral flux would be sharper, but
 * this is driving motion rather than transcribing a score, and it costs nothing.
 *
 * Kept pure and separate from the Web Audio graph so its behaviour can be tested
 * without a browser — the one part of the visualiser chain that cannot be checked by
 * looking at it.
 */
export function createOnsetDetector(): OnsetDetector {
  const history: number[] = [];
  let beat = 0;
  let lastOnset = -1;
  let warm = 0;
  let previous = 0;

  return {
    push: (bass, elapsed, delta, playing) => {
      const mean = history.length ? history.reduce((sum, value) => sum + value, 0) / history.length : 0;
      history.push(bass);
      if (history.length > HISTORY) history.shift();
      warm = playing ? warm + 1 : 0;

      // An onset is an attack, not a loud moment. Without the rising test, a level
      // that steps up and stays there keeps clearing the ratio until the running mean
      // catches up — a full second of phantom beats after every drop.
      const rising = bass > previous;
      previous = bass;

      beat = Math.max(0, beat - delta * BEAT_DECAY);
      if (warm > WARMUP && rising && bass > 0.04 && mean > 0 && bass > mean * ONSET_RATIO && elapsed - lastOnset > ONSET_GAP) {
        lastOnset = elapsed;
        beat = 1;
      }
      return beat;
    },
  };
}

export type AudioAnalyser = {
  /** Connects the graph. Safe to call repeatedly; only the first call builds it. */
  start(): void;
  /** Samples the analyser and advances the derived values. */
  read(elapsed: number, delta: number, playing: boolean): Signal;
  close(): void;
};

/**
 * Wraps the Web Audio graph for one media element. The element can only ever be
 * routed into one graph, so this is created once per viewer and shared by every
 * visualizer that gets mounted.
 */
export function createAudioAnalyser(media: HTMLMediaElement): AudioAnalyser {
  let context: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let started = false;

  let frequency = new Uint8Array(FFT_SIZE / 2);
  let waveform = new Uint8Array(FFT_SIZE);
  const onsets = createOnsetDetector();

  const start = (): void => {
    if (started) {
      void context?.resume();
      return;
    }
    started = true;
    try {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.72;
      context.createMediaElementSource(media).connect(analyser);
      // Routing through the graph replaces the element's own output, so the
      // analyser has to forward the signal on or playback goes silent.
      analyser.connect(context.destination);
      // A context built outside a gesture starts suspended, which would leave the
      // visualiser reading silence over perfectly audible music.
      void context.resume();
      frequency = new Uint8Array(analyser.frequencyBinCount);
      waveform = new Uint8Array(analyser.fftSize);
    } catch {
      void context?.close();
      context = undefined;
      analyser = undefined;
    }
  };

  const read = (elapsed: number, delta: number, playing: boolean): Signal => {
    if (analyser) {
      analyser.getByteFrequencyData(frequency);
      analyser.getByteTimeDomainData(waveform);
    }

    const bass = average(frequency, 1, 10);
    const mid = average(frequency, 10, 60);
    const treble = average(frequency, 60, 180);
    const level = average(frequency, 1, 180);

    const beat = onsets.push(bass, elapsed, delta, playing);
    return { frequency, waveform, bass, mid, treble, level, beat, elapsed, delta, playing };
  };

  return {
    start,
    read,
    close: () => {
      void context?.close();
      context = undefined;
      analyser = undefined;
    },
  };
}

function average(data: Uint8Array, from: number, to: number): number {
  const end = Math.min(to, data.length);
  if (end <= from) return 0;
  let sum = 0;
  for (let index = from; index < end; index += 1) sum += data[index];
  return sum / (end - from) / 255;
}
