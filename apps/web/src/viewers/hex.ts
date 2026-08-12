import { formatBytes } from "../filesystem";
import { hexLines } from "@fsn/core/parsers/binary";
import { el } from "./dom";
import type { ViewerHost } from "./types";

/** One screenful of a disk sector at a time; enough to identify a file, not to dump it. */
const WINDOW = 64 * 1024;

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("HEX MONITOR / RAW SECTOR");
  const bytes = await host.bytes(WINDOW);
  if (host.signal.aborted) return;

  const view = el("div", "hex-view");
  const table = el("pre", "hex-table");
  for (const line of hexLines(bytes)) {
    const row = el("div", "hex-row");
    row.append(el("span", "hex-offset", line.offset), el("span", "hex-bytes", line.hex), el("span", "hex-ascii", line.ascii));
    table.append(row);
  }
  view.append(table);
  host.mount(view);

  const total = host.node.size ?? bytes.length;
  host.setStatus(total > bytes.length ? `FIRST ${formatBytes(bytes.length)} OF ${formatBytes(total)}` : `${formatBytes(bytes.length)} DUMPED`);
}
