export type Sheet = {
  header: string[];
  rows: string[][];
  /** Rows present in the source, even when `rows` was capped. */
  totalRows: number;
  columns: number;
  truncated: boolean;
};

/**
 * Picks a separator by sampling the first line. Extension wins when it is explicit
 * (`.tsv`), otherwise the character with the highest count outside quotes takes it,
 * exported spreadsheets use semicolons in most of Europe.
 */
export function delimiterFor(name: string, sample: string): string {
  if (/\.tsv$/i.test(name)) return "\t";
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, character: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === character) count += 1;
  }
  return count;
}

/**
 * RFC 4180 reader: honours quoted fields, escaped `""` quotes, and embedded
 * newlines. `maxRows` caps what is returned without capping what is counted, so the
 * viewer can say how much it withheld.
 */
export function parseDelimited(text: string, delimiter: string, maxRows = 2_000): Sheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let dirty = false;
  let totalRows = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
    dirty = true;
  };
  const endRow = (): void => {
    endField();
    totalRows += 1;
    if (rows.length < maxRows) rows.push(row);
    row = [];
    dirty = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) endField();
    else if (char === "\n") endRow();
    else if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
    } else {
      field += char;
      dirty = true;
    }
  }
  // A trailing newline closes the last row; anything else leaves one buffered.
  if (dirty || field) endRow();

  const header = rows.shift() ?? [];
  if (header.length) totalRows -= 1;
  const columns = rows.reduce((widest, entry) => Math.max(widest, entry.length), header.length);
  return { header, rows, totalRows, columns, truncated: totalRows > rows.length };
}
