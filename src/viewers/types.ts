import type { FsNode } from "../filesystem";

export type ToggleSpec = {
  /** Rendered on the button, so it can carry the state: `PIXEL FILTER: ON`. */
  label: (on: boolean) => string;
  initial?: boolean;
  onChange: (on: boolean) => void;
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
  setMode(label: string): void;
  setStatus(label: string): void;
  addToggle(spec: ToggleSpec): void;
  onCleanup(dispose: () => void): void;
  /** Hands the object to a different renderer, e.g. the denied screen's hex override. */
  handOff(rendererId: RendererId): void;
};

export type RendererId =
  | "image" | "model" | "font" | "table" | "json" | "text"
  | "media" | "pdf" | "archive" | "hex" | "denied";

export type Renderer = (host: ViewerHost) => void | Promise<void>;
