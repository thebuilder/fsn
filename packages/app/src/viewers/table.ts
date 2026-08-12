import { delimiterFor, parseDelimited, type Sheet } from "@fsn/core/parsers/delimited";
import { el } from "./dom";
import type { ViewerHost } from "./types";

const NUMERIC = /^-?[$€£]?\s?\d[\d\s,.']*%?$/;
const SEPARATOR_NAMES = new Map([[",", "COMMA"], [";", "SEMICOLON"], ["\t", "TAB"], ["|", "PIPE"]]);

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("RECORD SHEET / READ ONLY");
  const value = await host.text();
  if (host.signal.aborted) return;

  const delimiter = delimiterFor(host.node.name, value.slice(0, 4_096));
  const sheet = parseDelimited(value, delimiter);
  if (!sheet.header.length) throw new Error("The sheet holds no columns.");

  host.mount(sheetTable(sheet));
  const separator = SEPARATOR_NAMES.get(delimiter) ?? "CUSTOM";
  host.setStatus(
    `${sheet.totalRows} ROWS / ${sheet.columns} COLS / ${separator}${sheet.truncated ? ` / FIRST ${sheet.rows.length} SHOWN` : ""}`,
  );
}

function sheetTable(sheet: Sheet): HTMLElement {
  const frame = el("div", "sheet-view");
  const table = el("table", "sheet");
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "sheet-corner", "#"));
  for (let column = 0; column < sheet.columns; column += 1) {
    const cell = el("th", undefined, sheet.header[column] ?? "");
    cell.scope = "col";
    headRow.append(cell);
  }
  head.append(headRow);

  const body = el("tbody");
  sheet.rows.forEach((row, index) => {
    const line = el("tr");
    const number = el("th", "sheet-index", String(index + 1));
    number.scope = "row";
    line.append(number);
    for (let column = 0; column < sheet.columns; column += 1) {
      const value = row[column] ?? "";
      line.append(el("td", NUMERIC.test(value.trim()) && value.trim() ? "is-numeric" : undefined, value));
    }
    body.append(line);
  });

  table.append(head, body);
  frame.append(table);
  if (sheet.truncated) {
    frame.append(el("p", "sheet-note", `Showing the first ${sheet.rows.length} of ${sheet.totalRows} rows.`));
  }
  return frame;
}
