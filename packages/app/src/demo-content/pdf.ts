/**
 * A hand-assembled PDF 1.4 writer: the standard 14 fonts, text, lines and rectangles,
 * one uncompressed content stream per page.
 *
 * That is the whole of what an operator's manual needs. Every character is written as
 * exactly one Latin-1 byte, so an offset in the cross-reference table is just a string
 * length — no multi-byte encoding can shift it. `makePdf` refuses anything wider.
 */

export type PdfFont = "F1" | "F2" | "F3";

/** Helvetica, Helvetica-Bold and Courier: present in every PDF reader without embedding. */
const FONTS: Record<PdfFont, string> = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Courier" };

export type PdfPage = {
  /** Raw content-stream operators, usually built with `PageBuilder`. */
  content: string;
};

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;

const escapeString = (text: string): string => text.replace(/[\\()]/g, (character) => `\\${character}`);
const number = (value: number): string => String(Math.round(value * 100) / 100);

/** Accumulates drawing operators for one page, top-down, in points. */
export class PageBuilder {
  private operators: string[] = [];

  text(font: PdfFont, size: number, x: number, y: number, text: string): this {
    this.operators.push(`BT /${font} ${size} Tf ${number(x)} ${number(PAGE_HEIGHT - y)} Td (${escapeString(text)}) Tj ET`);
    return this;
  }

  /** Greedy word wrap at a fixed character count; returns the y below the paragraph. */
  paragraph(font: PdfFont, size: number, x: number, y: number, text: string, columns: number, leading = size * 1.4): number {
    let cursor = y;
    for (const line of wrap(text, columns)) {
      this.text(font, size, x, cursor, line);
      cursor += leading;
    }
    return cursor;
  }

  color(red: number, green: number, blue: number): this {
    this.operators.push(`${number(red)} ${number(green)} ${number(blue)} rg ${number(red)} ${number(green)} ${number(blue)} RG`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.6): this {
    this.operators.push(`${number(width)} w ${number(x1)} ${number(PAGE_HEIGHT - y1)} m ${number(x2)} ${number(PAGE_HEIGHT - y2)} l S`);
    return this;
  }

  rect(x: number, y: number, width: number, height: number, fill = true): this {
    this.operators.push(`${number(x)} ${number(PAGE_HEIGHT - y - height)} ${number(width)} ${number(height)} re ${fill ? "f" : "S"}`);
    return this;
  }

  build(): PdfPage {
    return { content: this.operators.join("\n") };
  }
}

export function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > columns) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Serialises the pages with a catalog, page tree, font resources, info and a byte-exact xref. */
export function makePdf(pages: PdfPage[], info: { title: string; author: string; creationDate: string }): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const fontIds = Object.keys(FONTS).map((_, index) => 3 + index);
  const firstPage = 3 + fontIds.length;
  const pageIds = pages.map((_, index) => firstPage + index * 2);
  const infoId = firstPage + pages.length * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  const fontResources = Object.keys(FONTS).map((key, index) => `/${key} ${fontIds[index]} 0 R`).join(" ");
  Object.values(FONTS).forEach((base, index) => {
    objects[fontIds[index]] = `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;
  });
  pages.forEach((page, index) => {
    const id = pageIds[index];
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << ${fontResources} >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${page.content.length} >>\nstream\n${page.content}\nendstream`;
  });
  objects[infoId] = `<< /Title (${escapeString(info.title)}) /Author (${escapeString(info.author)}) /Producer (FSN demo press) /CreationDate (${info.creationDate}) >>`;

  // The binary-marker comment tells transfer tools this is not a text file.
  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Latin-1 so the four marker bytes land as single bytes and every offset stays a character count.
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code > 0xff) throw new Error("PDF text must be Latin-1.");
    bytes[index] = code;
  }
  return bytes;
}
