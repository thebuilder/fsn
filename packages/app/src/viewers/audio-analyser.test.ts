import { describe, expect, it } from "vitest";
import { createAudioAnalyser, createOnsetDetector } from "./audio-analyser";

const FRAME = 1 / 60;

/** Runs a sequence of per-frame bass energies and returns the frames that fired. */
function run(energies: number[], playing = true): { hits: number[]; peaks: number[] } {
  const detector = createOnsetDetector();
  const hits: number[] = [];
  const peaks: number[] = [];
  energies.forEach((energy, frame) => {
    const beat = detector.push(energy, frame * FRAME, FRAME, playing);
    peaks.push(beat);
    if (beat === 1) hits.push(frame);
  });
  return { hits, peaks };
}

/** A kick every `period` frames, over a steady bed. */
function pulseTrain(frames: number, period: number, quiet = 0.2, loud = 0.9): number[] {
  return Array.from({ length: frames }, (_, frame) => (frame % period === 0 ? loud : quiet));
}

describe("onset detection", () => {
  it("finds nothing in a steady signal", () => {
    expect(run(new Array(200).fill(0.5)).hits).toEqual([]);
  });

  it("finds nothing in silence", () => {
    expect(run(new Array(200).fill(0)).hits).toEqual([]);
  });

  it("fires once per kick in a steady pulse train", () => {
    // 30 frames at 60fps is a beat every half second — 120 bpm.
    const { hits } = run(pulseTrain(300, 30));

    expect(hits.length).toBeGreaterThanOrEqual(8);
    const gaps = hits.slice(1).map((frame, index) => frame - hits[index]);
    expect(new Set(gaps)).toEqual(new Set([30]));
  });

  it("does not fire twice on one long kick", () => {
    // A kick spread over four frames must still read as a single onset.
    const energies = Array.from({ length: 240 }, (_, frame) => (frame % 40 < 4 ? 0.9 : 0.2));

    const { hits } = run(energies);
    const gaps = hits.slice(1).map((frame, index) => frame - hits[index]);

    expect(gaps.every((gap) => gap >= 40)).toBe(true);
  });

  it("stays quiet while the transport is paused", () => {
    expect(run(pulseTrain(300, 30), false).hits).toEqual([]);
  });

  it("does not fire during the warm-up after playback starts", () => {
    // Pressing play takes the low end from nothing to full in a single frame, which
    // clears every ratio test going. That false onset is the wave that slams across
    // the screen the moment the track starts.
    const { hits } = run(new Array(60).fill(0.8));

    expect(hits).toEqual([]);
  });

  it("reads a step up in level as one onset, not a burst", () => {
    // Sustained loudness is not a beat. Before the rising test this fired every
    // seventh frame for a second, until the running mean caught up.
    const { hits } = run([...new Array(30).fill(0.2), ...new Array(90).fill(0.8)]);

    expect(hits).toHaveLength(1);
  });

  it("still catches the first real kick shortly after playback settles", () => {
    const { hits } = run([...new Array(40).fill(0.25), ...pulseTrain(200, 30)]);

    expect(hits.length).toBeGreaterThan(3);
  });

  it("decays the pulse between beats instead of latching", () => {
    const { peaks } = run(pulseTrain(120, 30));
    const firstHit = peaks.indexOf(1);

    expect(peaks[firstHit + 1]).toBeLessThan(1);
    expect(peaks[firstHit + 10]).toBe(0);
  });

  it("ignores a quiet passage that is merely louder than silence", () => {
    // Ratio alone would trigger here; the absolute floor is what rejects it.
    expect(run(new Array(200).fill(0).map((_, frame) => (frame % 30 === 0 ? 0.03 : 0.001))).hits).toEqual([]);
  });
});

describe("audio analyser buffers", () => {
  it("reads a waveform pinned to silence's midpoint before start() is ever called", () => {
    const analyser = createAudioAnalyser({} as HTMLMediaElement);

    const signal = analyser.read(0, 0, false);

    expect(Array.from(signal.waveform).every((byte) => byte === 128)).toBe(true);
  });
});
