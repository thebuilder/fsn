import { extensionOf } from "@fsn/core";
import { isAnimatedImage } from "@fsn/core/parsers/binary";
import { el } from "./dom";
import type { ViewerHost } from "./types";

/** Longest edge we rasterise to; keeps huge photos from allocating a vast canvas. */
const MAX_CANVAS_EDGE = 1_600;
/** Width, in blocks, of the downsampled image the pixel filter upscales from. */
const PIXEL_COLUMNS = 140;
/** Fallback frame duration for sequences that declare none. */
const DEFAULT_FRAME_MS = 100;

const ANIMATABLE = new Map([
  ["gif", "image/gif"],
  ["png", "image/png"],
  ["apng", "image/png"],
  ["webp", "image/webp"],
]);

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("PIXEL IMAGE VIEWER / 1.0");
  const source = await host.url();
  if (host.signal.aborted) return;

  const image = new Image();
  image.src = source;
  image.alt = host.node.name;
  image.className = "image-source";
  await settled(image);
  if (host.signal.aborted) return;
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error(`${extensionOf(host.node.name).toUpperCase() || "This format"} cannot be decoded by this browser.`);
  }

  const { sequence, animated } = await openSequence(host);
  if (host.signal.aborted) {
    sequence?.close();
    return;
  }

  const figure = el("figure", "image-view");
  const stage = el("div", "image-stage");
  const canvas = el("canvas", "image-surface");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", host.node.name);
  stage.append(canvas, image);
  figure.append(stage, el("figcaption", undefined, `${image.naturalWidth} × ${image.naturalHeight} PX / ${sequence ? `${sequence.frames} FRAME SEQUENCE` : "RGB CHANNEL"}`));
  host.mount(figure);
  host.onCleanup(() => sequence?.close());
  // The window takes the picture's shape; the figure's padding and caption are measured
  // off the stage by the host, so they survive the fit instead of being squeezed out.
  host.fitWindow({
    aspect: image.naturalWidth / image.naturalHeight,
    region: stage,
    // The image is never upscaled, so a window wider than the source would only add matting.
    maxWidth: image.naturalWidth,
    narrow: true,
  });

  const paint = createPainter(canvas, image.naturalWidth, image.naturalHeight);
  if ((animated && !sequence) || !paint(image)) {
    // Either rasterising failed, or this browser cannot decode the sequence for us:
    // the <img> plays it correctly on its own, so hand the pane over and drop the filter.
    canvas.remove();
    host.setStatus(animated ? "SEQUENCE PLAYING / FILTER UNAVAILABLE" : "IMAGE DECODED / FILTER UNAVAILABLE");
    return;
  }
  // The filter starts off: an image opens as itself, and the reader asks for blocks.
  // The canvas keeps the one paint above so switching it on has nothing to wait for.
  host.addToggle({
    label: (on) => `PIXEL FILTER: ${on ? "ON" : "OFF"}`,
    initial: false,
    onChange: (on) => {
      stage.classList.toggle("is-filtered", on);
      // Unfiltered playback is the <img>'s own job; the decoder rests until asked again.
      if (on) sequence ? sequence.play(paint, host) : paint(image);
      else sequence?.pause();
    },
  });

  host.setStatus(sequence ? `SEQUENCE DECODED / ${sequence.frames} FRAMES` : "IMAGE DECODED");
}

type Sequence = {
  frames: number;
  play: (paint: (source: CanvasImageSource) => boolean, host: ViewerHost) => void;
  pause: () => void;
  close: () => void;
};

/**
 * Animated images cannot be sampled from a live <img>: browsers stop advancing frames
 * for an element that is not actually visible, and the filtered view hides it behind
 * the canvas. So the frames are decoded here instead, which also gives us the real
 * inter-frame delays. Where ImageDecoder is missing the viewer keeps the plain <img>.
 */
async function openSequence(host: ViewerHost): Promise<{ sequence: Sequence | null; animated: boolean }> {
  const extension = extensionOf(host.node.name);
  const type = ANIMATABLE.get(extension);
  if (!type) return { sequence: null, animated: false };

  let animated = false;
  try {
    const bytes = await host.bytes();
    animated = !host.signal.aborted && isAnimatedImage(extension, bytes);
    if (!animated) return { sequence: null, animated: false };
    if (typeof ImageDecoder === "undefined" || !(await ImageDecoder.isTypeSupported(type))) {
      return { sequence: null, animated };
    }

    const decoder = new ImageDecoder({ data: bytes, type });
    await decoder.tracks.ready;
    const frames = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (frames < 2) {
      decoder.close();
      return { sequence: null, animated };
    }

    let timer = 0;
    let index = 0;
    let running = false;

    const advance = async (paint: (source: CanvasImageSource) => boolean, host: ViewerHost): Promise<void> => {
      if (!running || host.signal.aborted) return;
      try {
        const { image } = await decoder.decode({ frameIndex: index });
        if (!running || host.signal.aborted) {
          image.close();
          return;
        }
        paint(image);
        const duration = image.duration ? image.duration / 1_000 : DEFAULT_FRAME_MS;
        image.close();
        index = (index + 1) % frames;
        timer = window.setTimeout(() => void advance(paint, host), Math.max(20, duration));
      } catch {
        running = false;
      }
    };

    const sequence: Sequence = {
      frames,
      play: (paint, playHost) => {
        if (running) return;
        running = true;
        void advance(paint, playHost);
      },
      pause: () => {
        running = false;
        clearTimeout(timer);
      },
      close: () => {
        running = false;
        clearTimeout(timer);
        decoder.close();
      },
    };
    return { sequence, animated };
  } catch {
    // Any decoder failure just means the browser's own animation, without the filter.
    return { sequence: null, animated };
  }
}

/**
 * Waits on the load event rather than `decode()`: Chromium never settles the decode
 * promise for an animated image that is not yet in the document, which is exactly the
 * case here, and would hang the viewer on every GIF.
 */
function settled(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

/**
 * The pixel filter genuinely resamples: it averages down to PIXEL_COLUMNS wide, then
 * scales back up with smoothing off, which is the only way to get real blocks out of
 * a source that is never displayed larger than its natural size. The scratch surface
 * is built once because a sequence repaints on every frame.
 */
function createPainter(canvas: HTMLCanvasElement, naturalWidth: number, naturalHeight: number): (source: CanvasImageSource) => boolean {
  const fit = Math.min(1, MAX_CANVAS_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * fit));
  const height = Math.max(1, Math.round(naturalHeight * fit));
  canvas.width = width;
  canvas.height = height;

  const blockWidth = Math.max(8, Math.min(PIXEL_COLUMNS, width));
  const blockHeight = Math.max(1, Math.round(height * (blockWidth / width)));
  const scratch = document.createElement("canvas");
  scratch.width = blockWidth;
  scratch.height = blockHeight;

  const context = canvas.getContext("2d");
  const scratchContext = scratch.getContext("2d");
  if (!context || !scratchContext) return () => false;
  scratchContext.imageSmoothingEnabled = true;
  scratchContext.imageSmoothingQuality = "high";
  context.imageSmoothingEnabled = false;

  return (source) => {
    try {
      // Frames may carry transparency; clearing stops the previous one showing through.
      scratchContext.clearRect(0, 0, blockWidth, blockHeight);
      scratchContext.drawImage(source, 0, 0, blockWidth, blockHeight);
      context.clearRect(0, 0, width, height);
      context.drawImage(scratch, 0, 0, blockWidth, blockHeight, 0, 0, width, height);
      return true;
    } catch {
      return false;
    }
  };
}
