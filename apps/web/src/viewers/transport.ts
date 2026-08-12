import { el } from "./dom";

/** Custom deck controls. The native controls are switched off; this is the whole interface. */
export function createTransport(media: HTMLMediaElement): HTMLElement {
  const bar = el("div", "transport");

  const play = key("play", "Play");
  const stop = key("stop", "Stop");
  const elapsed = el("span", "transport-time", "0:00");
  const total = el("span", "transport-time", "--:--");

  const seek = el("input", "transport-seek");
  seek.type = "range";
  seek.min = "0";
  seek.max = "1";
  seek.step = "0.001";
  seek.value = "0";
  seek.ariaLabel = "Seek";

  const volume = el("input", "transport-volume");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = String(media.volume);
  volume.ariaLabel = "Volume";

  const mute = key("mute", "Mute");

  bar.append(play, stop, elapsed, seek, total, mute, volume);

  /** Paints the filled part of the seek bar; a plain range gives no progress read. */
  const paint = (): void => {
    const ratio = media.duration ? media.currentTime / media.duration : 0;
    seek.style.setProperty("--progress", `${ratio * 100}%`);
    volume.style.setProperty("--progress", `${(media.muted ? 0 : media.volume) * 100}%`);
  };

  let scrubbing = false;

  const setPlayState = (): void => {
    const playing = !media.paused && !media.ended;
    play.classList.toggle("is-playing", playing);
    play.ariaLabel = playing ? "Pause" : "Play";
    bar.classList.toggle("is-playing", playing);
  };

  media.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(media.duration)) {
      seek.max = String(media.duration);
      total.textContent = clock(media.duration);
    }
    paint();
  });
  media.addEventListener("timeupdate", () => {
    if (scrubbing) return;
    seek.value = String(media.currentTime);
    elapsed.textContent = clock(media.currentTime);
    paint();
  });
  media.addEventListener("play", setPlayState);
  media.addEventListener("pause", setPlayState);
  media.addEventListener("ended", setPlayState);
  media.addEventListener("volumechange", () => {
    volume.value = String(media.volume);
    mute.classList.toggle("is-muted", media.muted || media.volume === 0);
    mute.ariaLabel = media.muted ? "Unmute" : "Mute";
    paint();
  });

  play.addEventListener("click", () => {
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
  });
  stop.addEventListener("click", () => {
    media.pause();
    media.currentTime = 0;
    seek.value = "0";
    elapsed.textContent = clock(0);
    paint();
  });
  mute.addEventListener("click", () => {
    media.muted = !media.muted;
  });

  const scrubStart = (): void => {
    scrubbing = true;
  };
  const scrubEnd = (): void => {
    scrubbing = false;
  };

  /**
   * While the user drags, `timeupdate` must not fight them for the handle. Ending
   * that state is the delicate part: releasing the pointer anywhere but on the bar
   * itself used to leave the flag stuck on, and from then on the clock and the handle
   * were frozen for good while the track carried on playing behind them.
   *
   * Capture makes the release land here, and the remaining listeners are the nets for
   * every other way a drag can end — cancelled, stolen, or finished by keyboard.
   */
  const endDrag = (): void => {
    scrubEnd();
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("pointercancel", endDrag);
  };
  seek.addEventListener("pointerdown", (event) => {
    scrubStart();
    // Watch the document, not the bar: a pointer released anywhere else never sends
    // the bar an event, and the flag would stay latched for the rest of the session.
    // Both listeners remove themselves on the first release, so nothing accumulates.
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
    try {
      seek.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or stale pointer id; the document listeners still close this out.
    }
  });
  seek.addEventListener("pointerup", scrubEnd);
  seek.addEventListener("pointercancel", scrubEnd);
  seek.addEventListener("lostpointercapture", scrubEnd);
  seek.addEventListener("change", scrubEnd);
  seek.addEventListener("blur", scrubEnd);
  seek.addEventListener("keydown", scrubStart);
  seek.addEventListener("keyup", scrubEnd);
  seek.addEventListener("input", () => {
    const target = Number(seek.value);
    elapsed.textContent = clock(target);
    media.currentTime = target;
    paint();
  });
  volume.addEventListener("input", () => {
    media.volume = Number(volume.value);
    if (media.volume > 0) media.muted = false;
  });

  setPlayState();
  paint();
  return bar;
}

/**
 * Space and the arrow keys, the way every player has worked since the nineties.
 * Bound on the deck rather than the document so it cannot fight the file browser.
 */
export function bindTransportKeys(deck: HTMLElement, media: HTMLMediaElement): void {
  deck.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === " " || event.key === "k") {
      event.preventDefault();
      if (media.paused) void media.play().catch(() => undefined);
      else media.pause();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 30 : 5;
      media.currentTime = Math.max(0, Math.min(media.duration || 0, media.currentTime + (event.key === "ArrowRight" ? step : -step)));
    }
  });
}

function key(role: string, label: string): HTMLButtonElement {
  const button = el("button", `transport-key is-${role}`);
  button.type = "button";
  button.ariaLabel = label;
  button.append(el("i"));
  return button;
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
