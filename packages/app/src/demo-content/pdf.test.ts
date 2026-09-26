import { describe, expect, it } from "vitest";
import { operatorsManual } from "./manual";
import { makePdf, PageBuilder, wrap } from "./pdf";

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** Follows the file the way a reader does: from `startxref`, through the table, to each object. */
function crossReference(pdf: string): { xref: number; offsets: number[]; size: number } {
  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
  const table = pdf.slice(xref).split("\n");
  const size = Number(table[1].split(" ")[1]);
  const offsets = table.slice(3, 2 + size).map((row) => Number(row.slice(0, 10)));
  return { xref, offsets, size };
}

describe("PDF writer", () => {
  it("writes an xref table whose every offset lands on its object", () => {
    const page = new PageBuilder().text("F1", 12, 72, 72, "Hello (world) \\ back").build();
    const pdf = latin1(makePdf([page, page], { title: "T", author: "A", creationDate: "D:19960811" }));
    const { xref, offsets, size } = crossReference(pdf);

    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    offsets.forEach((offset, index) => expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true));
    expect(pdf).toContain(`/Size ${size} /Root 1 0 R`);
    expect(pdf).toContain("/Count 2");
  });

  it("escapes the characters that would end a PDF string early", () => {
    const page = new PageBuilder().text("F1", 12, 0, 0, "a (b) \\c").build();

    expect(page.content).toContain("(a \\(b\\) \\\\c) Tj");
  });

  it("declares each content stream's exact length", () => {
    const pdf = latin1(operatorsManual());
    for (const match of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index + match[0].length;
      expect(pdf.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe("\nendstream");
    }
  });

  it("wraps prose to the column without splitting words", () => {
    expect(wrap("one two three four five", 9)).toEqual(["one two", "three", "four five"]);
  });

  it("produces a four-page manual with a valid trailer", () => {
    const pdf = latin1(operatorsManual());
    const { offsets } = crossReference(pdf);

    expect(pdf).toContain("/Count 4");
    expect(pdf).toContain("(0x0007 OBJECT LOCKED) Tj");
    offsets.forEach((offset, index) => expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true));
  });
});
