import { el } from "./dom";
import type { ViewerHost } from "./types";

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("DOCUMENT READER / PDF");
  const source = await host.url();
  if (host.signal.aborted) return;
  const frame = el("iframe", "pdf-view");
  frame.title = `Preview of ${host.node.name}`;
  frame.src = source;
  host.mount(frame);
  host.setStatus("DOCUMENT READY");
}
