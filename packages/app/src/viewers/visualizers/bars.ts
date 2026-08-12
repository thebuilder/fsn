import { bandLevel, logBands } from "./bands";
import type { CreateVisualizer, Signal, Visualizer } from "./types";

const BARS = 52;
/** Highest bin a bar reads; above this is mostly hiss. */
const TOP_BIN = 220;
/** Per-second fall of the peak caps once the band drops away. */
const PEAK_FALL = 0.85;

/** Spectrum analyser: log-spaced bands, mirrored, with peak caps that sink back down. */
export const createBarsVisualizer: CreateVisualizer = (stage, width, height): Visualizer => {
  const canvas = document.createElement("canvas");
  canvas.className = "visualizer-canvas";
  stage.append(canvas);
  const context = canvas.getContext("2d");

  let ratio = Math.min(window.devicePixelRatio, 2);
  let size = { width, height };
  const levels = new Float32Array(BARS);
  const peaks = new Float32Array(BARS);

  const resize = (nextWidth: number, nextHeight: number): void => {
    ratio = Math.min(window.devicePixelRatio, 2);
    size = { width: nextWidth, height: nextHeight };
    canvas.width = Math.max(1, Math.round(nextWidth * ratio));
    canvas.height = Math.max(1, Math.round(nextHeight * ratio));
  };
  resize(width, height);

  const bands = logBands(BARS, TOP_BIN);

  return {
    resize,
    dispose: () => canvas.remove(),
    frame: (signal: Signal) => {
      if (!context) return;
      const { width: viewWidth, height: viewHeight } = size;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, viewWidth, viewHeight);

      const baseline = viewHeight * 0.72;
      const span = baseline - viewHeight * 0.08;
      const gap = Math.max(1, viewWidth / BARS * 0.22);
      const barWidth = viewWidth / BARS - gap;

      for (let index = 0; index < BARS; index += 1) {
        const target = bandLevel(signal.frequency, bands[index]) ** 1.15;
        // Rise fast, fall slow: the eye reads the attack, not the decay.
        levels[index] += (target - levels[index]) * (target > levels[index] ? 0.55 : 0.12);
        peaks[index] = Math.max(levels[index], peaks[index] - PEAK_FALL * signal.delta);

        const x = index * (barWidth + gap) + gap / 2;
        const barHeight = Math.max(2, levels[index] * span);
        // Graded over the bar's own height, so a loud band actually reaches the hot
        // end of the ramp instead of stopping in the cyan.
        const gradient = context.createLinearGradient(0, baseline, 0, baseline - barHeight);
        gradient.addColorStop(0, "#3ad9ff");
        gradient.addColorStop(0.55, "#86fadd");
        gradient.addColorStop(1, "#ff5b82");

        context.shadowBlur = 16;
        context.shadowColor = "rgba(90, 240, 220, 0.5)";
        context.fillStyle = gradient;
        context.fillRect(x, baseline - barHeight, barWidth, barHeight);

        // Reflection: the same bar, upside down and dim, as if the deck were glass.
        context.shadowBlur = 0;
        context.globalAlpha = 0.16;
        context.fillRect(x, baseline + 2, barWidth, barHeight * 0.45);
        context.globalAlpha = 1;

        const peakY = baseline - Math.max(3, peaks[index] * span);
        context.fillStyle = "#ffffff";
        context.globalAlpha = 0.8;
        context.fillRect(x, peakY - 2, barWidth, 2);
        context.globalAlpha = 1;
      }

      context.fillStyle = "rgba(134, 250, 221, 0.28)";
      context.fillRect(0, baseline, viewWidth, 1);
    },
  };
};
