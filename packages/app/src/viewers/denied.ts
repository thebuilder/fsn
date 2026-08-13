import { hasBytes } from "@fsn/core";
import { el } from "./dom";
import type { ViewerHost } from "./types";

export function render(host: ViewerHost): void {
  host.setMode("SECURITY MONITOR / KERNEL");
  const readable = hasBytes(host.node);
  const rows: Array<[string, string]> = [
    ["OPERATION", "READ / PREVIEW"],
    ["POLICY", readable ? "LOCAL-SAFE-01" : "SIMULATION"],
    ["RESULT", readable ? "TERMINATED" : "NO MEDIA"],
  ];
  const panel = el("div", "access-denied");
  const glyph = el("div", "denied-glyph");
  glyph.setAttribute("aria-hidden", "true");
  glyph.append(el("i"));

  const summary = el("p");
  summary.append(el("strong", undefined, host.node.name));
  summary.append(
    readable
      ? " is an unknown, binary, or protected object. FSN will not execute or decode it."
      : " exists in the demo filesystem as a catalogue entry only. There are no bytes behind it to read.",
  );

  const list = el("dl");
  for (const [term, value] of rows) {
    const row = el("div");
    row.append(el("dt", undefined, term), el("dd", undefined, value));
    list.append(row);
  }

  panel.append(glyph, el("p", "denied-code", "ERR 0x0007 / OBJECT LOCKED"), el("h3", undefined, "ACCESS DENIED"), summary, list);
  host.mount(panel);
  host.setStatus("OPERATION TERMINATED");

  // The denial is the default, not the ceiling: an operator can still read the bytes,
  // but only where there are bytes to read.
  if (readable) {
    const override = el("button", "tool-toggle", "FORCE HEX DUMP");
    override.type = "button";
    override.addEventListener("click", () => host.handOff("hex"));
    panel.append(override);
  }
}
