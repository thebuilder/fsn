/** A strike spreads over this many rows either side of its centre, as a soft gaussian. */
const STRIKE_SPREAD = 2;

export type WaveField = {
  /** Current displacement per cell, row-major. The array identity changes across steps. */
  read(): Float32Array;
  /**
   * Hits one row of the field, weighted per column. The displacement is added with
   * no matching change to the previous frame, which is what gives the strike an
   * initial velocity — it rings outward instead of subsiding in place.
   */
  strike(row: number, columnWeights: ArrayLike<number>, strength: number): void;
  /** Advances the simulation by one fixed step. */
  step(): void;
  clear(): void;
};

/**
 * A damped wave equation over a lattice: the classic leapfrog scheme, where each
 * cell accelerates toward the mean of its neighbours. Anything added to the field
 * propagates outward as a ring and dies away, which is exactly the attack-and-decay
 * a surface needs to answer a beat — the terrain scroll can only replay history.
 *
 * Pure and separate from the renderer for the same reason the onset detector is:
 * stability and propagation can be asserted in a test, not just eyeballed.
 *
 * `courant2` is the squared Courant number and must stay below 0.5, the stability
 * limit for the 2D scheme; `damping` is per-step energy retention.
 */
export function createWaveField(cols: number, rows: number, courant2: number, damping: number): WaveField {
  let current = new Float32Array(cols * rows);
  let previous = new Float32Array(cols * rows);

  return {
    read: () => current,

    strike: (row, columnWeights, strength) => {
      const from = Math.max(0, row - STRIKE_SPREAD);
      const to = Math.min(rows - 1, row + STRIKE_SPREAD);
      for (let column = 0; column < cols; column += 1) {
        const weight = columnWeights[column] ?? 0;
        for (let target = from; target <= to; target += 1) {
          const offset = target - row;
          current[target * cols + column] += strength * weight * Math.exp(-(offset * offset) / 2);
        }
      }
    },

    step: () => {
      for (let row = 0; row < rows; row += 1) {
        // Edges reflect (a missing neighbour reads as the cell itself), so a wave
        // that reaches the shoulder rolls back across the road instead of vanishing.
        const above = row > 0 ? -cols : 0;
        const below = row < rows - 1 ? cols : 0;
        for (let column = 0; column < cols; column += 1) {
          const index = row * cols + column;
          const left = column > 0 ? -1 : 0;
          const right = column < cols - 1 ? 1 : 0;
          const pull =
            current[index + left] + current[index + right] + current[index + above] + current[index + below] - 4 * current[index];
          previous[index] = (2 * current[index] - previous[index] + courant2 * pull) * damping;
        }
      }
      const swap = current;
      current = previous;
      previous = swap;
    },

    clear: () => {
      current.fill(0);
      previous.fill(0);
    },
  };
}
