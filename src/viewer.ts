import { canReadAsText, categoryOf, formatBytes, type FsNode } from "./filesystem";

type ViewerElements = {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  mode: HTMLElement;
  path: HTMLElement;
  size: HTMLElement;
  content: HTMLElement;
  position: HTMLElement;
  pixelToggle: HTMLButtonElement;
  close: HTMLButtonElement;
};

const MAX_TEXT_BYTES = 2_000_000;

export class FileViewer {
  private objectUrl: string | null = null;
  private pixelated = true;

  constructor(private readonly elements: ViewerElements) {
    elements.close.addEventListener("click", () => elements.dialog.close());
    elements.dialog.addEventListener("close", () => this.cleanup());
    elements.pixelToggle.addEventListener("click", () => this.togglePixels());
  }

  async open(node: FsNode, path: string): Promise<void> {
    this.cleanup();
    this.elements.title.textContent = node.name;
    this.elements.path.textContent = path;
    this.elements.size.textContent = formatBytes(node.size);
    this.elements.position.textContent = "READING OBJECT…";
    this.elements.content.replaceChildren(this.loadingView());
    this.elements.pixelToggle.hidden = true;
    if (!this.elements.dialog.open) this.elements.dialog.showModal();

    const category = categoryOf(node);
    try {
      if (category === "image") {
        await this.showImage(node);
      } else if (canReadAsText(node)) {
        await this.showText(node);
      } else if (category === "audio" || category === "video") {
        await this.showMedia(node, category);
      } else if (node.name.toLowerCase().endsWith(".pdf") && node.file) {
        this.showPdf(node);
      } else {
        this.showDenied(node);
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : "The object could not be decoded.");
    }
  }

  private async showImage(node: FsNode): Promise<void> {
    const source = node.demoImage ?? (node.file ? this.urlFor(node.file) : null);
    if (!source) return this.showDenied(node);
    this.elements.mode.textContent = "PIXEL IMAGE VIEWER / 1.0";
    this.elements.pixelToggle.hidden = false;
    this.pixelated = true;
    this.elements.pixelToggle.setAttribute("aria-pressed", "true");
    this.elements.pixelToggle.textContent = "PIXEL FILTER: ON";
    const frame = document.createElement("figure");
    frame.className = "image-view";
    const image = document.createElement("img");
    image.src = source;
    image.alt = node.name;
    image.className = "is-pixelated";
    await image.decode().catch(() => undefined);
    const caption = document.createElement("figcaption");
    caption.textContent = `${image.naturalWidth || "?"} × ${image.naturalHeight || "?"} PX / RGB CHANNEL`;
    frame.append(image, caption);
    this.elements.content.replaceChildren(frame);
    this.elements.position.textContent = "IMAGE DECODED";
  }

  private async showText(node: FsNode): Promise<void> {
    this.elements.mode.textContent = "SIMPLETEXT / READ ONLY";
    let value = node.demoContent;
    if (value === undefined && node.file) {
      if (node.file.size > MAX_TEXT_BYTES) throw new Error("Document exceeds the 2 MB terminal buffer.");
      value = await node.file.text();
    }
    if (value === undefined) return this.showDenied(node);
    const wrapper = document.createElement("div");
    wrapper.className = "text-document";
    const gutter = document.createElement("ol");
    gutter.className = "line-numbers";
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    const code = document.createElement("code");
    code.textContent = value;
    pre.append(code);
    value.split("\n").forEach(() => gutter.append(document.createElement("li")));
    wrapper.append(gutter, pre);
    this.elements.content.replaceChildren(wrapper);
    this.elements.position.textContent = `${value.split("\n").length} LINES / ${value.length} CHARS`;
  }

  private async showMedia(node: FsNode, category: "audio" | "video"): Promise<void> {
    if (!node.file) return this.showDenied(node);
    this.elements.mode.textContent = category === "audio" ? "SOUND PLAYER / CHANNEL A" : "MOVIE PLAYER / CHANNEL A";
    const deck = document.createElement("div");
    deck.className = "media-deck";
    const media = document.createElement(category);
    media.controls = true;
    media.src = this.urlFor(node.file);
    media.preload = "metadata";
    if (media instanceof HTMLVideoElement) media.playsInline = true;
    const display = document.createElement("div");
    display.className = "media-display";
    display.innerHTML = `<div class="equalizer" aria-hidden="true">${Array.from({ length: 18 }, (_, index) => `<i style="--bar:${(index * 7) % 13}"></i>`).join("")}</div><p>${category.toUpperCase()} DATA STREAM</p>`;
    deck.append(display, media);
    this.elements.content.replaceChildren(deck);
    this.elements.position.textContent = "MEDIA READY";
  }

  private showPdf(node: FsNode): void {
    if (!node.file) return this.showDenied(node);
    this.elements.mode.textContent = "DOCUMENT READER / PDF";
    const embed = document.createElement("iframe");
    embed.className = "pdf-view";
    embed.title = `Preview of ${node.name}`;
    embed.src = this.urlFor(node.file);
    this.elements.content.replaceChildren(embed);
    this.elements.position.textContent = "DOCUMENT READY";
  }

  private showDenied(node: FsNode): void {
    this.elements.mode.textContent = "SECURITY MONITOR / KERNEL";
    const panel = document.createElement("div");
    panel.className = "access-denied";
    panel.innerHTML = `<div class="denied-glyph" aria-hidden="true"><i></i></div><p class="denied-code">ERR 0x0007 / OBJECT LOCKED</p><h3>ACCESS DENIED</h3><p><strong>${escapeHtml(node.name)}</strong> is an unknown, binary, or protected object. FSN will not execute or decode it.</p><dl><div><dt>OPERATION</dt><dd>READ / PREVIEW</dd></div><div><dt>POLICY</dt><dd>LOCAL-SAFE-01</dd></div><div><dt>RESULT</dt><dd>TERMINATED</dd></div></dl>`;
    this.elements.content.replaceChildren(panel);
    this.elements.position.textContent = "OPERATION TERMINATED";
  }

  private showError(message: string): void {
    this.elements.mode.textContent = "SYSTEM EXCEPTION";
    const panel = document.createElement("div");
    panel.className = "access-denied";
    panel.innerHTML = `<p class="denied-code">I/O EXCEPTION</p><h3>READ FAILURE</h3><p>${escapeHtml(message)}</p>`;
    this.elements.content.replaceChildren(panel);
    this.elements.position.textContent = "READ FAILED";
  }

  private loadingView(): HTMLElement {
    const loader = document.createElement("div");
    loader.className = "viewer-loading";
    loader.innerHTML = `<i></i><p>MOUNTING OBJECT…</p>`;
    return loader;
  }

  private togglePixels(): void {
    this.pixelated = !this.pixelated;
    this.elements.pixelToggle.setAttribute("aria-pressed", String(this.pixelated));
    this.elements.pixelToggle.textContent = `PIXEL FILTER: ${this.pixelated ? "ON" : "OFF"}`;
    this.elements.content.querySelector("img")?.classList.toggle("is-pixelated", this.pixelated);
  }

  private urlFor(file: File): string {
    this.objectUrl = URL.createObjectURL(file);
    return this.objectUrl;
  }

  private cleanup(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.elements.content.querySelectorAll("audio, video").forEach((element) => (element as HTMLMediaElement).pause());
  }
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}
