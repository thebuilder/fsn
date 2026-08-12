import { extensionOf } from "@fsn/core";
import { el } from "./dom";
import type { ViewerHost } from "./types";

const PANGRAM = "The quick brown fox jumps over the lazy dog";
const SIZES = [64, 36, 24, 18, 13];
const GLYPH_ROWS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789 & @ # % ‰ § ¶",
  "( ) [ ] { } / \\ | — – - · • … ",
  "! ? ¿ ¡ \" ' ‘ ’ “ ” « » † ‡",
  "€ £ $ ¥ ¢ + − × ÷ = ≠ ≤ ≥ ∞",
];

let counter = 0;

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("FONT SPECIMEN / TYPE 1.0");
  const bytes = await host.bytes();
  if (host.signal.aborted) return;

  const family = `fsn-specimen-${(counter += 1)}`;
  const face = new FontFace(family, bytes as BufferSource);
  await face.load();
  if (host.signal.aborted) return;
  document.fonts.add(face);
  host.onCleanup(() => document.fonts.delete(face));

  const sheet = el("div", "specimen");
  sheet.style.setProperty("--specimen", `"${family}"`);

  const heading = el("p", "specimen-name", host.node.name.replace(/\.[^.]+$/, ""));
  sheet.append(heading);

  for (const size of SIZES) {
    const line = el("p", "specimen-line", PANGRAM);
    line.style.fontSize = `${size}px`;
    line.append(el("small", undefined, `${size}px`));
    sheet.append(line);
  }

  const grid = el("div", "specimen-grid");
  for (const row of GLYPH_ROWS) grid.append(el("p", undefined, row));
  sheet.append(grid);

  host.mount(sheet);
  host.addToggle({
    label: (on) => `SPECIMEN: ${on ? "TYPEFACE" : "SYSTEM"}`,
    initial: true,
    onChange: (on) => sheet.classList.toggle("is-system", !on),
  });
  host.setStatus(`${extensionOf(host.node.name).toUpperCase()} MOUNTED / ${face.style} ${face.weight}`);
}
