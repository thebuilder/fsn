import type { CreateVisualizer, Signal, Visualizer } from "./types";

/** Oscilloscope with phosphor persistence: the trace fades instead of being cleared. */
export const createScopeVisualizer: CreateVisualizer = (stage, width, height): Visualizer => {
  const canvas = document.createElement("canvas");
  canvas.className = "visualizer-canvas";
  stage.append(canvas);
  const context = canvas.getContext("2d");

  let ratio = Math.min(window.devicePixelRatio, 2);
  let size = { width, height };

  const resize = (nextWidth: number, nextHeight: number): void => {
    ratio = Math.min(window.devicePixelRatio, 2);
    size = { width: nextWidth, height: nextHeight };
    canvas.width = Math.max(1, Math.round(nextWidth * ratio));
    canvas.height = Math.max(1, Math.round(nextHeight * ratio));
    if (context) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, nextWidth, nextHeight);
    }
  };
  resize(width, height);

  return {
    resize,
    dispose: () => canvas.remove(),
    frame: (signal: Signal) => {
      if (!context) return;
      const { width: viewWidth, height: viewHeight } = size;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Persistence: dim what is already there rather than wiping it.
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = `rgba(0, 0, 0, ${Math.min(0.55, 0.16 + signal.delta * 3)})`;
      context.fillRect(0, 0, viewWidth, viewHeight);
      context.globalCompositeOperation = "source-over";

      const middle = viewHeight / 2;
      context.strokeStyle = "rgba(134, 250, 221, 0.16)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, middle);
      context.lineTo(viewWidth, middle);
      context.stroke();

      const samples = signal.waveform;
      const step = viewWidth / (samples.length - 1);
      const swing = viewHeight * 0.42 * (1 + signal.beat * 0.18);

      context.beginPath();
      for (let index = 0; index < samples.length; index += 1) {
        const value = (samples[index] - 128) / 128;
        const y = middle - value * swing;
        if (index === 0) context.moveTo(0, y);
        else context.lineTo(index * step, y);
      }

      context.shadowBlur = 18;
      context.shadowColor = "rgba(80, 240, 255, 0.75)";
      context.strokeStyle = signal.beat > 0.35 ? "#ff5b82" : "#7dfbe4";
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.stroke();
      context.shadowBlur = 0;
    },
  };
};
