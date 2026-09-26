import { makePdf, PAGE_WIDTH, PageBuilder, type PdfPage } from "./pdf";

/** Text column: one-inch margins on US Letter. */
const LEFT = 72;
const COLUMNS = 84;
const CODE_COLUMNS = 76;

type Section = { heading: string; body: Array<string | { code: string[] } | { table: Array<[string, string]> }> };

const CHAPTERS: Array<{ title: string; sections: Section[] }> = [
  {
    title: "1. Getting around",
    sections: [
      {
        heading: "1.1 The landscape",
        body: [
          "FSN draws one directory at a time as a district. Every file is a tower standing on a shared plinth; the taller the tower, the more bytes it holds. Directories are raised platforms, and the platform's footprint is a preview of what waits inside.",
          "The layout is deterministic. A directory you return to next week will be laid out exactly as you left it, so an operator can learn a filesystem the way one learns a city: by landmarks.",
        ],
      },
      {
        heading: "1.2 Controls",
        body: [
          {
            table: [
              ["Drag", "Orbit around the centre of the view"],
              ["Scroll", "Dolly in and out"],
              ["W A S D", "Fly; the arrow keys turn (hold Alt to swap them)"],
              ["R / F", "Rise and descend"],
              ["Click", "Select an object and read its placard"],
              ["Double-click", "Enter a directory, or open a file"],
              ["Esc / Backspace", "Return to the parent directory"],
              ["/", "Search the filesystem"],
              ["?", "Show the control reference"],
            ],
          },
          "Movement has momentum. Release the keys a little before you arrive; the craft will glide the rest of the way.",
        ],
      },
    ],
  },
  {
    title: "2. Reading objects",
    sections: [
      {
        heading: "2.1 Viewers",
        body: [
          "Opening a file hands it to the viewer that understands it: SimpleText for prose and source, a record sheet for CSV and TSV, a tree for JSON, a sound deck for audio, a pixel viewer for pictures, a turntable for models, a specimen sheet for fonts, a manifest for archives, and this reader for documents.",
          "Archives are listed from their index only. FSN does not extract or execute anything it finds inside.",
        ],
      },
      {
        heading: "2.2 Objects FSN will not open",
        body: [
          "Applications, system files and unknown binaries are refused with ERR 0x0007 / OBJECT LOCKED. This is policy, not failure. An operator who needs to see the bytes anyway may press FORCE HEX DUMP, which shows the first sixty-four kilobytes as a raw sector listing.",
          { code: ["00000000  53 51 4C 69 74 65 20 66  6F 72 6D 61 74 20 33 00  SQLite format 3.", "00000010  10 00 01 01 00 40 20 20  00 00 00 2A 00 00 00 03  .....@  ...*...."] },
          "The right-hand column is the printable text. Most files announce what they are in the first sixteen bytes.",
        ],
      },
    ],
  },
  {
    title: "3. Troubleshooting",
    sections: [
      {
        heading: "3.1 Error codes",
        body: [
          {
            table: [
              ["0x0001 PHOSPHOR COLD", "The display has not warmed up. Wait ten seconds."],
              ["0x0003 GRID UNBOUNDED", "The floor extends forever. This is expected."],
              ["0x0007 OBJECT LOCKED", "See section 2.2."],
              ["0x000B ARCHIVE LINK DEGRADED", "Check the Logs district for the uplink."],
              ["0x0010 HORIZON REACHED", "Should never occur. Report it at once."],
            ],
          },
        ],
      },
      {
        heading: "3.2 If the city goes dark",
        body: [
          "Press Backspace until you reach the root, then take your hands off the controls. The navigator will settle and the lights will come back one district at a time.",
          "If they do not, the problem is not with FSN. Check the fence.",
        ],
      },
    ],
  },
];

function cover(): PdfPage {
  const page = new PageBuilder();
  page.color(0.02, 0.04, 0.05).rect(0, 0, PAGE_WIDTH, 792);
  // A perspective floor receding to a horizon, the manual's only illustration.
  page.color(0.45, 0.97, 0.83);
  const horizon = 430;
  const vanish = PAGE_WIDTH / 2;
  for (let index = -12; index <= 12; index += 1) page.line(vanish, horizon, vanish + index * 90, 792, 0.5);
  for (let row = 1; row <= 14; row += 1) {
    const y = horizon + (792 - horizon) * (row / 14) ** 2;
    page.line(0, y, PAGE_WIDTH, y, 0.5);
  }
  page.line(0, horizon, PAGE_WIDTH, horizon, 1.2);
  page.color(1, 0.35, 0.49).rect(LEFT, 150, 6, 118);
  page.color(0.45, 0.97, 0.83)
    .text("F2", 12, LEFT + 20, 164, "OPERATOR SERIES / VOLUME 1")
    .text("F2", 44, LEFT + 20, 214, "FILE SYSTEM")
    .text("F2", 44, LEFT + 20, 260, "NAVIGATOR")
    .text("F1", 14, LEFT + 20, 300, "Operator's Manual, Revision 0.1")
    .text("F3", 9, LEFT, 740, "DOCUMENT FSN-OM-0001 / DISTRIBUTION: OPERATORS ONLY / DO NOT FOLD");
  return page.build();
}

function chapter(title: string, sections: Section[], number: number): PdfPage {
  const page = new PageBuilder();
  page.color(1, 0.35, 0.49).rect(LEFT, 60, PAGE_WIDTH - LEFT * 2, 3);
  page.color(0.1, 0.1, 0.12).text("F2", 22, LEFT, 100, title);
  let y = 140;
  for (const section of sections) {
    page.color(0.1, 0.1, 0.12).text("F2", 13, LEFT, y, section.heading);
    y += 22;
    for (const block of section.body) {
      if (typeof block === "string") {
        page.color(0.15, 0.15, 0.18);
        y = page.paragraph("F1", 10.5, LEFT, y, block, COLUMNS) + 8;
      } else if ("code" in block) {
        const height = block.code.length * 12 + 12;
        page.color(0.93, 0.95, 0.94).rect(LEFT, y - 12, PAGE_WIDTH - LEFT * 2, height);
        page.color(0.05, 0.35, 0.28);
        block.code.forEach((line, index) => page.text("F3", 7.5, LEFT + 8, y + 2 + index * 12, line.slice(0, CODE_COLUMNS + 20)));
        y += height + 8;
      } else {
        for (const [term, meaning] of block.table) {
          page.color(0.05, 0.35, 0.28).text("F3", 9.5, LEFT + 6, y, term);
          page.color(0.15, 0.15, 0.18).text("F1", 10, LEFT + 190, y, meaning);
          page.color(0.8, 0.82, 0.84).line(LEFT, y + 5, PAGE_WIDTH - LEFT, y + 5, 0.4);
          y += 17;
        }
        y += 10;
      }
    }
    y += 14;
  }
  page.color(0.5, 0.5, 0.55).text("F1", 9, LEFT, 750, "FSN Operator's Manual").text("F1", 9, PAGE_WIDTH - LEFT - 12, 750, String(number));
  return page.build();
}

/** "manual.pdf": a cover and three chapters that are, incidentally, true about this app. */
export function operatorsManual(): Uint8Array<ArrayBuffer> {
  const pages = [cover(), ...CHAPTERS.map((entry, index) => chapter(entry.title, entry.sections, index + 2))];
  return makePdf(pages, { title: "FSN Operator's Manual", author: "Operations", creationDate: "D:19960811021400" });
}
