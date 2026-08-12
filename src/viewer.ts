import { formatBytes, type FsNode } from "./filesystem";
import { el, noticePanel } from "./viewers/dom";
import { rendererById, rendererFor } from "./viewers/registry";
import type { Choice, ChoiceSpec, RendererId, ToggleSpec, ViewerHost, WindowFit } from "./viewers/types";

type ViewerElements = {
  dialog: HTMLDialogElement;
  titlebar: HTMLElement;
  title: HTMLElement;
  mode: HTMLElement;
  path: HTMLElement;
  size: HTMLElement;
  content: HTMLElement;
  position: HTMLElement;
  tools: HTMLElement;
  zoom: HTMLButtonElement;
  collapse: HTMLButtonElement;
  grow: HTMLButtonElement;
  close: HTMLButtonElement;
};

/** The inline size a zoomed window returns to, plus the drag offset it had. */
type Geometry = { width: string; height: string; x: number; y: number };
/** A pixel-space window box, used as the origin a resize gesture measures against. */
type WindowBox = { width: number; height: number; x: number; y: number };

const MAX_TEXT_BYTES = 2_000_000;
const MIN_WIDTH = 340;
const MIN_HEIGHT = 260;
/** Gap kept between the window and the viewport edge when it is resized or zoomed. */
const VIEWPORT_INSET = 16;
/** How much of the window must stay on screen, so a dragged title bar is always grabbable. */
const DRAG_MARGIN = 96;
const KEY_RESIZE_STEP = 16;
const KEY_RESIZE_STEP_LARGE = 64;
/** Below this the stylesheet gives the viewer the whole screen, so there is no window to shape. */
const FULLSCREEN_WINDOW = "(max-width: 600px)";

/**
 * Owns the viewer window: chrome, object lifetime and dispatch. The actual rendering
 * lives in `viewers/`, one dynamically imported module per format, so the bundle only
 * pays for the kinds of file a session actually opens.
 */
export class FileViewer {
  private controller = new AbortController();
  private disposers: Array<() => void> = [];
  private objectUrls: string[] = [];
  private payload: Promise<Blob> | null = null;
  private offsetX = 0;
  private offsetY = 0;
  private maximized = false;
  private collapsed = false;
  private restoreGeometry: Geometry | null = null;
  /** The shape the current object asked for, kept so a viewport resize can re-fit. */
  private fit: WindowFit | null = null;
  /** Whether the size on the dialog came from a fit rather than from the reader's own hand. */
  private fitted = false;
  private fitFrame = 0;

  constructor(private readonly elements: ViewerElements) {
    elements.close.addEventListener("click", () => elements.dialog.close());
    // `close` is delivered asynchronously, so a dialog that has already been reopened
    // for the next object would otherwise be torn down by the previous one's event.
    elements.dialog.addEventListener("close", () => {
      if (!elements.dialog.open) this.reset();
    });
    elements.zoom.addEventListener("click", () => {
      this.setCollapsed(false);
      this.setMaximized(!this.maximized);
    });
    elements.collapse.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    elements.titlebar.addEventListener("pointerdown", (event) => this.startDrag(event));
    elements.titlebar.addEventListener("dblclick", (event) => {
      if (!(event.target as HTMLElement).closest("button")) this.setCollapsed(!this.collapsed);
    });
    elements.grow.addEventListener("pointerdown", (event) => this.startResize(event));
    elements.grow.addEventListener("keydown", (event) => this.resizeByKey(event));
    window.addEventListener("resize", () => {
      this.scheduleFit();
      this.applyGeometry();
    });
  }

  async open(node: FsNode, path: string): Promise<void> {
    this.reset();
    // A size the last object asked for means nothing to this one; a size the reader
    // dragged out themselves is theirs to keep until they open something with an opinion.
    this.fit = null;
    cancelAnimationFrame(this.fitFrame);
    if (this.fitted) this.clearSize();
    this.elements.title.textContent = node.name;
    this.elements.path.textContent = path;
    this.elements.size.textContent = formatBytes(node.size);
    this.elements.mode.textContent = "OBJECT VIEWER";
    if (!this.elements.dialog.open) this.elements.dialog.showModal();
    // Without this the dialog autofocuses the close light, which draws a focus ring
    // on a window the reader opened with the mouse. The content region is the honest
    // landing spot: it scrolls, and it only rings when the reader is on the keyboard.
    this.elements.content.focus({ preventScroll: true });
    this.setCollapsed(false);
    this.applyGeometry();
    await this.dispatch(rendererFor(node), node, path);
  }

  private async dispatch(entry: ReturnType<typeof rendererFor>, node: FsNode, path: string): Promise<void> {
    const { signal } = this.controller;
    this.elements.position.textContent = "READING OBJECT…";
    this.elements.content.replaceChildren(loadingView());
    this.elements.tools.replaceChildren();

    try {
      const module = await entry.load();
      if (signal.aborted) return;
      await module.render(this.hostFor(node, path, signal));
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      this.elements.mode.textContent = "SYSTEM EXCEPTION";
      this.elements.tools.replaceChildren();
      this.elements.content.replaceChildren(
        noticePanel("I/O EXCEPTION", "READ FAILURE", error instanceof Error ? error.message : "The object could not be decoded."),
      );
      this.elements.position.textContent = "READ FAILED";
    }
  }

  private hostFor(node: FsNode, path: string, signal: AbortSignal): ViewerHost {
    const blob = (): Promise<Blob> => (this.payload ??= this.readPayload(node, signal));
    return {
      node,
      path,
      signal,
      blob,
      bytes: async (limit) => {
        const source = await blob();
        const slice = limit !== undefined && source.size > limit ? source.slice(0, limit) : source;
        return new Uint8Array(await slice.arrayBuffer());
      },
      text: async (limit = MAX_TEXT_BYTES) => {
        if (node.demoContent !== undefined) return node.demoContent;
        const source = await blob();
        if (source.size > limit) throw new Error(`Object exceeds the ${formatBytes(limit)} terminal buffer.`);
        return source.text();
      },
      url: async () => {
        if (node.demoAsset && !node.file) return node.demoAsset;
        const url = URL.createObjectURL(node.file ?? (await blob()));
        this.objectUrls.push(url);
        return url;
      },
      mount: (element) => {
        if (!signal.aborted) this.elements.content.replaceChildren(element);
      },
      fitWindow: (fit) => {
        if (signal.aborted) return;
        this.fit = fit;
        this.scheduleFit(signal);
      },
      setMode: (label) => {
        if (!signal.aborted) this.elements.mode.textContent = label;
      },
      setStatus: (label) => {
        if (!signal.aborted) this.elements.position.textContent = label;
      },
      addToggle: (spec) => this.addToggle(spec, signal),
      addChoice: (spec) => this.addChoice(spec, signal),
      onCleanup: (dispose) => this.disposers.push(dispose),
      handOff: (id: RendererId) => {
        if (!signal.aborted) void this.dispatch(rendererById(id), node, path);
      },
    };
  }

  /** Local files, demo assets and inline demo text all reduce to one blob. */
  private async readPayload(node: FsNode, signal: AbortSignal): Promise<Blob> {
    if (node.file) return node.file;
    if (node.demoAsset) {
      const response = await fetch(node.demoAsset, { signal });
      if (!response.ok) throw new Error(`Demo object unavailable (HTTP ${response.status}).`);
      return response.blob();
    }
    if (node.demoContent !== undefined) return new Blob([node.demoContent], { type: "text/plain" });
    throw new Error("This object has no readable bytes in the current session.");
  }

  private addToggle(spec: ToggleSpec, signal: AbortSignal): void {
    if (signal.aborted) return;
    let on = spec.initial ?? true;
    const button = el("button", "tool-toggle", spec.label(on));
    button.type = "button";
    button.setAttribute("aria-pressed", String(on));
    button.addEventListener("click", () => {
      on = !on;
      button.textContent = spec.label(on);
      button.setAttribute("aria-pressed", String(on));
      spec.onChange(on);
    });
    this.elements.tools.prepend(button);
  }

  private startDrag(event: PointerEvent): void {
    if (event.button !== 0 || this.maximized) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const bar = this.elements.titlebar;
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = this.offsetX;
    const originY = this.offsetY;
    bar.classList.add("is-dragging");
    this.trackPointer(bar, event, (moveEvent) => {
      this.offsetX = originX + moveEvent.clientX - startX;
      this.offsetY = originY + moveEvent.clientY - startY;
      this.applyGeometry();
    }, () => bar.classList.remove("is-dragging"));
  }

  private startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.setMaximized(false);
    const dialog = this.elements.dialog;
    const startX = event.clientX;
    const startY = event.clientY;
    const from: WindowBox = { width: dialog.offsetWidth, height: dialog.offsetHeight, x: this.offsetX, y: this.offsetY };
    this.trackPointer(this.elements.grow, event, (moveEvent) => {
      this.resizeTo(from.width + moveEvent.clientX - startX, from.height + moveEvent.clientY - startY, from);
    });
  }

  private resizeByKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? KEY_RESIZE_STEP_LARGE : KEY_RESIZE_STEP;
    const deltas: Record<string, [number, number]> = {
      ArrowRight: [step, 0],
      ArrowLeft: [-step, 0],
      ArrowDown: [0, step],
      ArrowUp: [0, -step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    this.setMaximized(false);
    const from: WindowBox = { width: this.elements.dialog.offsetWidth, height: this.elements.dialog.offsetHeight, x: this.offsetX, y: this.offsetY };
    this.resizeTo(from.width + delta[0], from.height + delta[1], from);
  }

  /**
   * The dialog is centred by the UA margins, so a size change moves both edges.
   * Shifting by half the growth pins the top-left corner, which is what makes the
   * grow box track the pointer instead of running away at double speed.
   */
  private resizeTo(width: number, height: number, from: WindowBox): void {
    // The reader has taken over the size, so the object's own preference stops applying.
    this.fit = null;
    this.fitted = false;
    const nextWidth = clamp(width, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_INSET));
    const nextHeight = clamp(height, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_INSET));
    this.elements.dialog.style.width = `${nextWidth}px`;
    this.elements.dialog.style.height = `${nextHeight}px`;
    this.offsetX = from.x + (nextWidth - from.width) / 2;
    this.offsetY = from.y + (nextHeight - from.height) / 2;
    this.applyGeometry();
  }

  private setMaximized(next: boolean): void {
    if (next === this.maximized) return;
    const dialog = this.elements.dialog;
    this.maximized = next;
    dialog.classList.toggle("is-maximized", next);
    if (next) {
      this.restoreGeometry = { width: dialog.style.width, height: dialog.style.height, x: this.offsetX, y: this.offsetY };
      this.offsetX = 0;
      this.offsetY = 0;
    } else if (this.restoreGeometry) {
      dialog.style.width = this.restoreGeometry.width;
      dialog.style.height = this.restoreGeometry.height;
      this.offsetX = this.restoreGeometry.x;
      this.offsetY = this.restoreGeometry.y;
      this.restoreGeometry = null;
      // An object opened while the window was zoomed never got its shape; it does now.
      this.applyFit();
    }
    this.elements.zoom.setAttribute("aria-pressed", String(next));
    this.elements.zoom.setAttribute("aria-label", next ? "Restore window size" : "Maximize window");
    this.elements.zoom.title = next ? "Restore" : "Maximize";
    this.applyGeometry();
  }

  /** Window shade: rolls the frame up to the title bar, which stays where it is. */
  private setCollapsed(next: boolean): void {
    if (next === this.collapsed) return;
    const dialog = this.elements.dialog;
    const before = dialog.offsetHeight;
    this.collapsed = next;
    dialog.classList.toggle("is-collapsed", next);
    const after = dialog.offsetHeight;
    // The window is centred, so a height change moves both edges; half of it pins the bar.
    if (before > 0 && after > 0) this.offsetY += (after - before) / 2;
    this.elements.collapse.setAttribute("aria-pressed", String(next));
    this.elements.collapse.setAttribute("aria-label", next ? "Expand window" : "Collapse window");
    this.elements.collapse.title = next ? "Expand" : "Collapse";
    this.applyGeometry();
  }

  /**
   * Fits on a frame rather than now: content is often only just mounted, and a page the
   * browser has not laid out — a hidden tab, a viewport mid-resize — measures nothing
   * worth sizing from. A frame is also when the reader stops seeing the intermediate size.
   */
  private scheduleFit(signal?: AbortSignal): void {
    if (!this.fit) return;
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      if (signal?.aborted) return;
      this.applyFit();
      this.applyGeometry();
    });
  }

  /**
   * Shapes the window around the object instead of the other way round: the content
   * region is handed the aspect the renderer asked for and the frame grows or shrinks
   * in height around it. The viewport is the ceiling — when the height runs into it a
   * renderer that allows narrowing gives up width rather than letterbox its picture.
   */
  private applyFit(): void {
    const fit = this.fit;
    const dialog = this.elements.dialog;
    const content = this.elements.content;
    if (!fit || !dialog.open || this.maximized || this.collapsed) return;
    // A full-screen viewer has no window to shape, and an inline size would break out of it.
    if (window.matchMedia(FULLSCREEN_WINDOW).matches) return;

    // Measure from the stylesheet's own size, so repeated fits do not compound.
    this.clearSize();
    const baseWidth = dialog.offsetWidth;
    // The chrome is the title bar, toolbar, footer and the frame around the content pane.
    const chromeWidth = baseWidth - content.clientWidth;
    const chromeHeight = dialog.offsetHeight - content.clientHeight;
    // A hidden or not-yet-laid-out tab measures nothing worth sizing from.
    if (baseWidth <= 0 || chromeWidth < 0 || chromeHeight < 0 || !(fit.aspect > 0)) return;

    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_INSET);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_INSET);
    // Everything that is not the region itself: the window's chrome plus whatever the
    // content lays out around it, both measured at the size the stylesheet just gave back.
    const region = fit.region;
    const spentWidth = chromeWidth + (region ? Math.max(0, content.clientWidth - region.offsetWidth) : 0);
    const spentHeight = chromeHeight + (region ? Math.max(0, content.clientHeight - region.offsetHeight) : 0);
    let width = Math.min(baseWidth, maxWidth, (fit.maxWidth ?? Infinity) + spentWidth);
    let height = spentHeight + (width - spentWidth) / fit.aspect;
    if (height > maxHeight && fit.narrow) {
      // All the height there is; the region keeps its aspect by taking less width.
      width = Math.min(width, (maxHeight - spentHeight) * fit.aspect + spentWidth);
    }
    height = clamp(height, MIN_HEIGHT, maxHeight);
    width = clamp(width, MIN_WIDTH, maxWidth);
    dialog.style.width = `${Math.round(width)}px`;
    dialog.style.height = `${Math.round(height)}px`;
    this.fitted = true;
  }

  private clearSize(): void {
    this.elements.dialog.style.width = "";
    this.elements.dialog.style.height = "";
    this.fitted = false;
  }

  /**
   * Writes the drag offset back as a transform, first pulling it into range.
   * The untransformed position is derived rather than measured because the open
   * animation also writes a transform, which would poison a live rect reading.
   */
  private applyGeometry(): void {
    const dialog = this.elements.dialog;
    if (!dialog.open) return;
    // A hidden or not-yet-laid-out tab measures zero; clamping against that would
    // fling the window somewhere arbitrary, so leave the position alone instead.
    const measurable = dialog.offsetWidth > 0 && window.innerWidth > 0 && window.innerHeight > 0;
    if (!this.maximized && measurable) {
      const width = Math.min(dialog.offsetWidth, Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_INSET));
      const height = Math.min(dialog.offsetHeight, Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_INSET));
      if (dialog.style.width) dialog.style.width = `${width}px`;
      // A collapsed window measures the shade, not the window; writing that back as the
      // inline height would roll the frame up for good the moment it is expanded again.
      if (dialog.style.height && !this.collapsed) dialog.style.height = `${height}px`;
      const baseLeft = (window.innerWidth - width) / 2;
      const baseTop = (window.innerHeight - height) / 2;
      this.offsetX = clamp(this.offsetX, DRAG_MARGIN - width - baseLeft, window.innerWidth - DRAG_MARGIN - baseLeft);
      this.offsetY = clamp(this.offsetY, -baseTop, Math.max(0, window.innerHeight - this.elements.titlebar.offsetHeight) - baseTop);
    }
    dialog.style.transform = this.offsetX || this.offsetY ? `translate(${Math.round(this.offsetX)}px, ${Math.round(this.offsetY)}px)` : "";
  }

  private trackPointer(target: HTMLElement, event: PointerEvent, onMove: (event: PointerEvent) => void, onEnd?: () => void): void {
    // Capture keeps the gesture alive past the window edge; not every pointer allows it.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // The gesture still works through the listeners below.
    }
    const end = (): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      onEnd?.();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  private addChoice(spec: ChoiceSpec, signal: AbortSignal): Choice {
    if (signal.aborted) return { select: () => undefined };
    const group = el("div", "viewer-switch");
    group.role = "group";
    group.ariaLabel = spec.label;
    let active = spec.initial;

    const buttons = spec.options.map((option) => {
      const button = el("button", "tool-toggle", option.label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(option.id === active));
      group.append(button);
      return { option, button };
    });

    const paint = (): void => {
      for (const entry of buttons) entry.button.setAttribute("aria-pressed", String(entry.option.id === active));
    };
    for (const { option, button } of buttons) {
      button.addEventListener("click", () => {
        if (option.id === active) return;
        active = option.id;
        paint();
        spec.onChange(active);
      });
    }
    this.elements.tools.prepend(group);

    return {
      select: (id) => {
        active = id;
        paint();
      },
    };
  }

  private reset(): void {
    this.controller.abort();
    this.controller = new AbortController();
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose();
      } catch {
        // A renderer failing to tear down must not block the rest of the teardown.
      }
    }
    this.disposers = [];
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this.payload = null;
    this.elements.content.querySelectorAll("audio, video").forEach((element) => (element as HTMLMediaElement).pause());
    this.elements.tools.replaceChildren();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function loadingView(): HTMLElement {
  const loader = el("div", "viewer-loading");
  loader.append(el("i"), el("p", undefined, "MOUNTING OBJECT…"));
  return loader;
}
