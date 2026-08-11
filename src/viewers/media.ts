import { categoryOf } from "../filesystem";
import { el } from "./dom";
import type { ViewerHost } from "./types";

const BARS = 18;
/** 256 samples → 128 bins, ~190 Hz each: fine enough to separate bass from presence. */
const FFT_SIZE = 256;
/** Highest bin a bar reads. The top of the range is mostly hiss, so it is left out. */
const TOP_BIN = 96;

export async function render(host: ViewerHost): Promise<void> {
  const isVideo = categoryOf(host.node) === "video";
  host.setMode(isVideo ? "MOVIE PLAYER / CHANNEL A" : "SOUND PLAYER / CHANNEL A");
  const source = await host.url();
  if (host.signal.aborted) return;

  const media = document.createElement(isVideo ? "video" : "audio");
  media.controls = true;
  media.src = source;
  media.preload = "metadata";
  if (media instanceof HTMLVideoElement) media.playsInline = true;

  const deck = el("div", "media-deck");
  const display = el("div", `media-display${isVideo ? " is-slim" : ""}`);
  const equalizer = el("div", "equalizer");
  equalizer.setAttribute("aria-hidden", "true");
  const bars = Array.from({ length: BARS }, (_, index) => {
    const bar = el("i");
    bar.style.setProperty("--bar", String((index * 7) % 13));
    equalizer.append(bar);
    return bar;
  });
  display.append(equalizer);
  if (!isVideo) display.append(el("p", undefined, "AUDIO DATA STREAM"));
  const credit = host.node.demoCredit;
  if (credit) {
    const line = el("p", "media-credit");
    if (credit.href) {
      const link = el("a", undefined, credit.text);
      link.href = credit.href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      line.append(link);
    } else {
      line.textContent = credit.text;
    }
    display.append(line);
  }

  // The picture leads for video; for audio the meter is the only thing to look at.
  if (isVideo) deck.append(media, display);
  else deck.append(display, media);
  host.mount(deck);
  host.setStatus("MEDIA READY");

  attachAnalyser(media, bars, host);

  media.addEventListener("error", () => {
    host.setStatus("STREAM UNSUPPORTED");
    display.classList.add("is-dead");
  });
  media.addEventListener("playing", () => host.setStatus("STREAM PLAYING"));
  media.addEventListener("pause", () => host.setStatus("STREAM PAUSED"));
  media.addEventListener("ended", () => host.setStatus("END OF STREAM"));
}

/**
 * Drives the equalizer from the real signal instead of a CSS loop. The graph is built
 * on first play because an AudioContext may only start from a user gesture, and
 * routing through it means the element's own output now flows via `destination`.
 */
function attachAnalyser(media: HTMLMediaElement, bars: HTMLElement[], host: ViewerHost): void {
  let context: AudioContext | undefined;
  let frame = 0;
  // An element can only be routed into one graph, so a failed attempt is never retried.
  let started = false;

  const start = (): void => {
    if (started) {
      void context?.resume();
      return;
    }
    started = true;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.75;
      context.createMediaElementSource(media).connect(analyser);
      analyser.connect(context.destination);

      const spectrum = new Uint8Array(analyser.frequencyBinCount);
      const bands = logBands(bars.length, Math.min(TOP_BIN, analyser.frequencyBinCount - 1));
      const tick = (): void => {
        frame = requestAnimationFrame(tick);
        analyser.getByteFrequencyData(spectrum);
        bars.forEach((bar, index) => {
          const [from, to] = bands[index];
          let sum = 0;
          for (let bin = from; bin < to; bin += 1) sum += spectrum[bin];
          bar.style.setProperty("--bar", ((sum / (to - from) / 255) * 16).toFixed(2));
        });
      };
      frame = requestAnimationFrame(tick);
    } catch {
      // No Web Audio (or the source is tainted): the static bars remain.
      void context?.close();
      context = undefined;
    }
  };

  media.addEventListener("play", start);
  media.addEventListener("playing", start);
  host.onCleanup(() => {
    cancelAnimationFrame(frame);
    media.pause();
    void context?.close();
  });
}

/**
 * Splits the spectrum into logarithmic bands, the way hearing does. Linear bars would
 * spend most of their width on treble nobody notices and leave the bass in one column.
 */
function logBands(count: number, topBin: number): Array<[number, number]> {
  const bands: Array<[number, number]> = [];
  let previous = 1;
  for (let index = 1; index <= count; index += 1) {
    const edge = Math.round(topBin ** (index / count));
    const to = Math.max(previous + 1, Math.min(edge, topBin));
    bands.push([previous, to]);
    previous = to;
  }
  return bands;
}
