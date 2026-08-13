import { describe, expect, it } from "vitest";
import { createWaveField } from "./wavefield";

const COLS = 16;
const ROWS = 32;
const COURANT2 = 0.22;
const DAMPING = 0.994;

const uniform = new Array(COLS).fill(1);

function energy(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return sum;
}

describe("createWaveField", () => {
  it("starts flat and stays flat without a strike", () => {
    const field = createWaveField(COLS, ROWS, COURANT2, DAMPING);
    for (let step = 0; step < 50; step += 1) field.step();
    expect(energy(field.read())).toBe(0);
  });

  it("propagates a strike outward across the rows", () => {
    const field = createWaveField(COLS, ROWS, COURANT2, DAMPING);
    const origin = 8;
    field.strike(origin, uniform, 1);

    // A distant row is quiet at first and disturbed once the wave has had time
    // to reach it — displacement travels, rather than appearing everywhere at once.
    const distant = origin + 12;
    const rowLevel = (): number => {
      let peak = 0;
      const values = field.read();
      for (let column = 0; column < COLS; column += 1) {
        peak = Math.max(peak, Math.abs(values[distant * COLS + column]));
      }
      return peak;
    };

    for (let step = 0; step < 5; step += 1) field.step();
    expect(rowLevel()).toBeLessThan(0.01);

    for (let step = 0; step < 40; step += 1) field.step();
    expect(rowLevel()).toBeGreaterThan(0.01);
  });

  it("weights the strike per column", () => {
    const field = createWaveField(COLS, ROWS, COURANT2, DAMPING);
    const weights = new Array(COLS).fill(0);
    weights[3] = 1;
    field.strike(10, weights, 1);
    const values = field.read();
    expect(values[10 * COLS + 3]).toBeCloseTo(1);
    expect(values[10 * COLS + 12]).toBe(0);
  });

  it("decays instead of blowing up", () => {
    const field = createWaveField(COLS, ROWS, COURANT2, DAMPING);
    field.strike(8, uniform, 1);
    for (let step = 0; step < 30; step += 1) field.step();
    const early = energy(field.read());
    for (let step = 0; step < 600; step += 1) field.step();
    const late = energy(field.read());
    expect(late).toBeLessThan(early * 0.1);
    for (const value of field.read()) expect(Math.abs(value)).toBeLessThan(2);
  });

  it("clears to silence", () => {
    const field = createWaveField(COLS, ROWS, COURANT2, DAMPING);
    field.strike(8, uniform, 1);
    for (let step = 0; step < 10; step += 1) field.step();
    field.clear();
    for (let step = 0; step < 10; step += 1) field.step();
    expect(energy(field.read())).toBe(0);
  });
});
