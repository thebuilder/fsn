/** One frame of analysis, handed to whichever visualizer is mounted. */
export type Signal = {
  /** Byte spectrum, 0-255 per bin, low frequency first. */
  frequency: Uint8Array;
  /** Byte waveform, 0-255 around a 128 centre line. */
  waveform: Uint8Array;
  /** Band energies, 0-1. */
  bass: number;
  mid: number;
  treble: number;
  /** Overall loudness, 0-1. */
  level: number;
  /** Decaying pulse, 1 on an onset and falling away after it. */
  beat: number;
  /** Seconds since the visualizer mounted; advances whether or not audio plays. */
  elapsed: number;
  /** Seconds since the previous frame, clamped so a background tab cannot lurch. */
  delta: number;
  playing: boolean;
};

export type Visualizer = {
  frame(signal: Signal): void;
  resize(width: number, height: number): void;
  /** Clears accumulated history. Called on a seek, where the old trail is a lie. */
  reset?(): void;
  dispose(): void;
};

/** Visualizers are created against a mounted, already-sized element. */
export type CreateVisualizer = (stage: HTMLElement, width: number, height: number) => Visualizer;
