export type LineSeparator = "\r\n" | "\n" | "\r";

export type DecodedTextDocument = {
  /** Textarea-ready content. Browsers expose textarea line breaks as LF. */
  value: string;
  hadUtf8Bom: boolean;
  /** Original separators by line boundary, retained so mixed files round-trip. */
  lineSeparators: LineSeparator[];
};

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const LINE_SEPARATOR = /\r\n|\r|\n/g;

/** Strictly decodes UTF-8 and separates file-format details from editor content. */
export function decodeTextDocument(bytes: Uint8Array): DecodedTextDocument {
  const hadUtf8Bom = UTF8_BOM.every((byte, index) => bytes[index] === byte);
  const payload = hadUtf8Bom ? bytes.subarray(UTF8_BOM.length) : bytes;
  let decoded: string;

  try {
    // BOM handling is explicit above; preserve any subsequent U+FEFF as content.
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("This object is not valid UTF-8 text.");
    throw error;
  }

  const lineSeparators = Array.from(decoded.matchAll(LINE_SEPARATOR), (match) => match[0] as LineSeparator);
  return {
    value: decoded.replace(LINE_SEPARATOR, "\n"),
    hadUtf8Bom,
    lineSeparators,
  };
}

/**
 * Restores original separators by boundary. Extra editor lines use the dominant
 * separator from the source; when counts tie, the first source separator wins.
 */
export function serializeTextDocument(value: string, source: DecodedTextDocument): string {
  const canonical = value.replace(LINE_SEPARATOR, "\n");
  const lines = canonical.split("\n");
  const fallback = preferredSeparator(source.lineSeparators);
  const output = [source.hadUtf8Bom ? "\uFEFF" : "", lines[0] ?? ""];

  for (let index = 1; index < lines.length; index += 1) {
    output.push(source.lineSeparators[index - 1] ?? fallback, lines[index]);
  }
  return output.join("");
}

function preferredSeparator(separators: LineSeparator[]): LineSeparator {
  if (!separators.length) return "\n";
  const counts = new Map<LineSeparator, number>();
  for (const separator of separators) counts.set(separator, (counts.get(separator) ?? 0) + 1);

  let preferred = separators[0];
  let highest = counts.get(preferred) ?? 0;
  for (const separator of separators) {
    const count = counts.get(separator) ?? 0;
    if (count > highest) {
      preferred = separator;
      highest = count;
    }
  }
  return preferred;
}
