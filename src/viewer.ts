import { formatBytes, type FsNode } from "./filesystem";
import { el, noticePanel } from "./viewers/dom";
import { rendererById, rendererFor } from "./viewers/registry";
import type { RendererId, ToggleSpec, ViewerHost } from "./viewers/types";

type ViewerElements = {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  mode: HTMLElement;
  path: HTMLElement;
  size: HTMLElement;
  content: HTMLElement;
  position: HTMLElement;
  tools: HTMLElement;
  close: HTMLButtonElement;
};

const MAX_TEXT_BYTES = 2_000_000;

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

  constructor(private readonly elements: ViewerElements) {
    elements.close.addEventListener("click", () => elements.dialog.close());
    elements.dialog.addEventListener("close", () => this.reset());
  }

  async open(node: FsNode, path: string): Promise<void> {
    this.reset();
    this.elements.title.textContent = node.name;
    this.elements.path.textContent = path;
    this.elements.size.textContent = formatBytes(node.size);
    this.elements.mode.textContent = "OBJECT VIEWER";
    if (!this.elements.dialog.open) this.elements.dialog.showModal();
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
      setMode: (label) => {
        if (!signal.aborted) this.elements.mode.textContent = label;
      },
      setStatus: (label) => {
        if (!signal.aborted) this.elements.position.textContent = label;
      },
      addToggle: (spec) => this.addToggle(spec, signal),
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

function loadingView(): HTMLElement {
  const loader = el("div", "viewer-loading");
  loader.append(el("i"), el("p", undefined, "MOUNTING OBJECT…"));
  return loader;
}
