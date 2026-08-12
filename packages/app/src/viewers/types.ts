import type { FsNode } from "@fsn/core";

export type ToggleSpec = {
  /** Rendered on the button, so it can carry the state: `PIXEL FILTER: ON`. */
  label: (on: boolean) => string;
  initial?: boolean;
  onChange: (on: boolean) => void;
};

/** A segmented group in the toolbar for picking one of several modes. */
export type ChoiceSpec = {
  /** Names the group for assistive technology. */
  label: string;
  options: Array<{ id: string; label: string }>;
  initial: string;
  onChange: (id: string) => void;
};

export type Choice = {
  /** Moves the selection without firing `onChange` — for reverting a failed switch. */
  select(id: string): void;
};

/**
 * The shape a renderer would like its window to take. The host owns the arithmetic;
 * a renderer only describes the region it wants shown whole.
 */
export type WindowFit = {
  /** Width ÷ height of that region — an image's pixels, a video's frame, a page. */
  aspect: number;
  /**
   * The element holding that region. Whatever the content lays out around it — its own
   * padding, a caption, a transport — is measured off this and kept, so the window ends
   * up exactly as large as the region plus its furniture.
   */
  region?: HTMLElement;
  /** Largest useful width for the region, so a 64px icon does not get a 1000px window. */
  maxWidth?: number;
  /**
   * Whether the window may give up width to keep the aspect once the viewport has
   * capped its height. True for pictures, which would otherwise sit in a wide letterbox;
   * false for readers that need their width whatever shape the content is.
   */
  narrow?: boolean;
};

/**
 * Everything a renderer is allowed to touch. Renderers never see the dialog, the
 * toolbar or each other; the host owns the chrome and the lifetime, which is what
 * lets every renderer be an independently loaded chunk.
 */
export type ViewerHost = {
  readonly node: FsNode;
  readonly path: string;
  /** Aborts when the viewer closes or moves to another object; check it after every await. */
  readonly signal: AbortSignal;
  blob(): Promise<Blob>;
  bytes(limit?: number): Promise<Uint8Array>;
  text(limit?: number): Promise<string>;
  /** URL valid until the viewer closes; object URLs are revoked for you. */
  url(): Promise<string>;
  mount(element: Element): void;
  /** Asks the window to take a shape that suits this object. Ignored once the reader resizes. */
  fitWindow(fit: WindowFit): void;
  setMode(label: string): void;
  setStatus(label: string): void;
  addToggle(spec: ToggleSpec): void;
  addChoice(spec: ChoiceSpec): Choice;
  onCleanup(dispose: () => void): void;
  /** Hands the object to a different renderer, e.g. the denied screen's hex override. */
  handOff(rendererId: RendererId): void;
};

export type RendererId =
  | "image" | "model" | "font" | "table" | "json" | "text"
  | "media" | "pdf" | "archive" | "hex" | "denied";

export type Renderer = (host: ViewerHost) => void | Promise<void>;
