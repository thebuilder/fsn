import { el } from "./dom";
import type { ViewerHost } from "./types";

/** The line-numbered SimpleText pane, shared with the JSON viewer's raw mode. */
export function textDocument(value: string): HTMLElement {
  const wrapper = el("div", "text-document");
  const gutter = el("ol", "line-numbers");
  const pre = el("pre");
  pre.tabIndex = 0;
  pre.append(el("code", undefined, value));
  for (let index = value.split("\n").length; index > 0; index -= 1) gutter.append(el("li"));
  wrapper.append(gutter, pre);
  return wrapper;
}

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("SIMPLETEXT / READ ONLY");
  const value = await host.text();
  if (host.signal.aborted) return;
  host.mount(textDocument(value));
  host.setStatus(`${value.split("\n").length} LINES / ${value.length} CHARS`);
}
