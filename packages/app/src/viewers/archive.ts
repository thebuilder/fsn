import { formatBytes, formatDate } from "@fsn/core";
import { readZipDirectory, type ZipEntry } from "@fsn/core/parsers/zip";
import { el } from "./dom";
import type { ViewerHost } from "./types";

/**
 * How much of the tail to read. The index lives at the end of a ZIP, so this is all
 * we ever need to touch; 8 MB covers an archive with roughly a hundred thousand
 * entries without pulling a multi-gigabyte file into memory.
 */
const WINDOW = 8 * 1024 * 1024;

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("ARCHIVE MANIFEST / INDEX ONLY");
  const blob = await host.blob();
  if (host.signal.aborted) return;

  const base = Math.max(0, blob.size - WINDOW);
  const tail = new Uint8Array(await blob.slice(base).arrayBuffer());
  if (host.signal.aborted) return;

  const directory = readZipDirectory(tail, base);
  const files = directory.entries.filter((entry) => !entry.isDirectory);
  const folders = directory.entries.length - files.length;

  const frame = el("div", "manifest-view");
  if (directory.comment) frame.append(el("p", "manifest-comment", directory.comment));
  frame.append(manifestTable(directory.entries));
  frame.append(el("p", "manifest-note", "Contents are listed from the archive index. FSN does not extract or execute archived objects."));
  host.mount(frame);

  const ratio = directory.uncompressedTotal
    ? ` / ${Math.round((1 - directory.compressedTotal / directory.uncompressedTotal) * 100)}% SAVED`
    : "";
  host.setStatus(`${files.length} OBJECTS${folders ? ` / ${folders} DIRS` : ""} / ${formatBytes(directory.uncompressedTotal)}${ratio}`);
}

function manifestTable(entries: ZipEntry[]): HTMLElement {
  const table = el("table", "manifest");
  const headRow = el("tr");
  for (const label of ["NAME", "SIZE", "PACKED", "SAVED", "METHOD", "MODIFIED"]) {
    const cell = el("th", undefined, label);
    cell.scope = "col";
    headRow.append(cell);
  }
  const head = el("thead");
  head.append(headRow);

  const body = el("tbody");
  for (const entry of entries) {
    const row = el("tr", entry.isDirectory ? "is-directory" : undefined);
    const name = el("td", "manifest-name", entry.name);
    if (entry.encrypted) name.append(el("i", "manifest-lock", "ENCRYPTED"));
    row.append(
      name,
      el("td", "is-numeric", entry.isDirectory ? "-" : formatBytes(entry.uncompressedSize)),
      el("td", "is-numeric", entry.isDirectory ? "-" : formatBytes(entry.compressedSize)),
      el("td", "is-numeric", savings(entry)),
      el("td", undefined, entry.isDirectory ? "-" : entry.method),
      el("td", undefined, formatDate(entry.modified)),
    );
    body.append(row);
  }

  table.append(head, body);
  return table;
}

function savings(entry: ZipEntry): string {
  if (entry.isDirectory || !entry.uncompressedSize) return "-";
  return `${Math.round((1 - entry.compressedSize / entry.uncompressedSize) * 100)}%`;
}
