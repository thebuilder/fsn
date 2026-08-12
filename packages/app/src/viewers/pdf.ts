import { el } from "./dom";
import type { ViewerHost } from "./types";

/**
 * US Letter, the shape the window asks to be. A page is taller than any screen at the
 * width of this frame, so in practice this asks for every row the viewport can spare —
 * which is what reading a document wants. Narrowing is refused: the embedded reader
 * carries its own toolbar and page controls, and needs the width to lay them out.
 */
const PAGE_ASPECT = 8.5 / 11;

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("DOCUMENT READER / PDF");
  const source = await host.url();
  if (host.signal.aborted) return;
  const frame = el("iframe", "pdf-view");
  frame.title = `Preview of ${host.node.name}`;
  frame.src = source;
  host.mount(frame);
  host.fitWindow({ aspect: PAGE_ASPECT, narrow: false });
  host.setStatus("DOCUMENT READY");
}
