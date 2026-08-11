import { categoryOf } from "../filesystem";
import { createAudioAnalyser } from "./audio-analyser";
import { el } from "./dom";
import { bindTransportKeys, createTransport } from "./transport";
import type { ViewerHost } from "./types";
import type { CreateVisualizer, Visualizer } from "./visualizers/types";

/** Longest frame step we will integrate; a backgrounded tab must not lurch on return. */
const MAX_DELTA = 1 / 20;

const VISUALIZERS: Record<string, { label: string; load: () => Promise<CreateVisualizer> }> = {
  grid: { label: "GRID", load: async () => (await import("./visualizers/grid")).createGridVisualizer },
  bars: { label: "BARS", load: async () => (await import("./visualizers/bars")).createBarsVisualizer },
  scope: { label: "SCOPE", load: async () => (await import("./visualizers/scope")).createScopeVisualizer },
};

export async function render(host: ViewerHost): Promise<void> {
  const isVideo = categoryOf(host.node) === "video";
  host.setMode(isVideo ? "MOVIE PLAYER / CHANNEL A" : "SOUND PLAYER / CHANNEL A");
  const source = await host.url();
  if (host.signal.aborted) return;

  const media = document.createElement(isVideo ? "video" : "audio");
  media.src = source;
  media.preload = "metadata";
  // The deck draws its own transport; the browser's chrome would fight it.
  media.controls = false;
  if (media instanceof HTMLVideoElement) media.playsInline = true;

  const deck = el("div", `media-deck${isVideo ? " is-video" : ""}`);
  deck.tabIndex = 0;
  const stage = el("div", "visualizer-stage");
  if (isVideo) deck.append(media, stage);
  else deck.append(stage, media);
  deck.append(createTransport(media));
  bindTransportKeys(deck, media);

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
    deck.append(line);
  }

  host.mount(deck);
  host.setStatus("MEDIA READY");

  const analyser = createAudioAnalyser(media);
  // An AudioContext may only start from a gesture, so the graph waits for the first play.
  media.addEventListener("play", analyser.start);
  media.addEventListener("playing", analyser.start);

  let visualizer: Visualizer | null = null;
  let mounting = 0;
  let mounted = "";
  let choice: { select(id: string): void } | null = null;

  const bounds = (): { width: number; height: number } => {
    const rect = stage.getBoundingClientRect();
    return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  };

  const mount = async (id: string): Promise<void> => {
    const token = (mounting += 1);
    const entry = VISUALIZERS[id];
    if (!entry) return;
    let create: CreateVisualizer;
    try {
      create = await entry.load();
    } catch {
      // The visualizers are separate chunks, so a switch can fail on a bad connection
      // or against a dev server that has restarted under a stale page. Put the tab
      // back on whatever is actually running rather than let it claim otherwise.
      if (host.signal.aborted) return;
      host.setStatus(`${entry.label} UNAVAILABLE / RELOAD TO RETRY`);
      if (mounted) choice?.select(mounted);
      return;
    }
    // A slow chunk must not replace a visualizer the operator has since switched away from.
    if (host.signal.aborted || token !== mounting) return;

    visualizer?.dispose();
    visualizer = null;
    stage.replaceChildren();
    const { width, height } = bounds();
    try {
      visualizer = create(stage, width, height);
      mounted = id;
    } catch {
      // A refused WebGL context should not take the player down with it.
      stage.replaceChildren(el("p", "visualizer-fallback", "VISUALIZER UNAVAILABLE ON THIS DISPLAY"));
    }
  };

  if (isVideo) {
    // The picture is the visual; the meter is a garnish beneath it.
    void mount("bars");
  } else {
    void mount("grid");
    choice = host.addChoice({
      label: "Visualizer",
      options: Object.entries(VISUALIZERS).map(([id, entry]) => ({ id, label: entry.label })),
      initial: "grid",
      onChange: (id) => void mount(id),
    });
  }

  const observer = new ResizeObserver(() => {
    const { width, height } = bounds();
    visualizer?.resize(width, height);
  });
  observer.observe(stage);

  let frame = 0;
  let previous = performance.now();
  let elapsed = 0;
  const tick = (now: number): void => {
    frame = requestAnimationFrame(tick);
    const delta = Math.min(MAX_DELTA, Math.max(0, (now - previous) / 1000));
    previous = now;
    elapsed += delta;
    // No visibility check: the browser already stops serving frames to a hidden tab,
    // and skipping work on a frame it *did* serve just leaves the stage blank.
    if (!visualizer) return;
    visualizer.frame(analyser.read(elapsed, delta, !media.paused && !media.ended));
  };
  frame = requestAnimationFrame(tick);

  // After a jump the trail on screen belongs to a part of the track we are no longer
  // in, so the visualizer drops its history rather than scrolling a lie off-stage.
  media.addEventListener("seeked", () => visualizer?.reset?.());

  media.addEventListener("error", () => {
    host.setStatus("STREAM UNSUPPORTED");
    deck.classList.add("is-dead");
  });
  media.addEventListener("playing", () => host.setStatus("STREAM PLAYING"));
  media.addEventListener("pause", () => host.setStatus(media.currentTime === 0 ? "STREAM STOPPED" : "STREAM PAUSED"));
  media.addEventListener("ended", () => host.setStatus("END OF STREAM"));

  host.onCleanup(() => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    visualizer?.dispose();
    media.pause();
    analyser.close();
  });

  /**
   * Opening the object is itself a gesture, so this is usually permitted. When it is
   * not, the deck just waits: there is no muted fallback, because a player that
   * silently "plays" is worse than one that visibly needs a button pressed.
   */
  void media.play().catch(() => {
    if (!host.signal.aborted) host.setStatus("READY / PRESS PLAY");
  });
}
