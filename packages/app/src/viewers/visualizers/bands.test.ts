import { describe, expect, it } from "vitest";
import { bandLevel, logBands } from "./bands";

describe("log bands", () => {
  it("gives every band at least one bin", () => {
    const bands = logBands(52, 220);

    expect(bands).toHaveLength(52);
    expect(bands.every(([from, to]) => to > from)).toBe(true);
  });

  it("tiles the range without gaps or overlap", () => {
    const bands = logBands(24, 220);

    expect(bands[0][0]).toBe(1);
    expect(bands[bands.length - 1][1]).toBe(220);
    expect(bands.slice(1).every(([from], index) => from === bands[index][1])).toBe(true);
  });

  it("widens toward the top and never narrows", () => {
    const bands = logBands(24, 220);
    const widths = bands.map(([from, to]) => to - from);

    expect(widths[0]).toBeLessThan(widths[widths.length - 1]);
    expect(widths.every((width, index) => index === 0 || width >= widths[index - 1])).toBe(true);
  });

  it("packs the bottom octaves into single-bin bands", () => {
    // Worth pinning down rather than assuming: log spacing gives the low end *more*
    // bands, not fewer. Fine for a spectrum; a trap for anything driving geometry,
    // since those bins are pegged throughout a loud passage.
    const bands = logBands(24, 220);

    expect(bands.filter(([from, to]) => to - from === 1).length).toBeGreaterThan(8);
  });

  it("averages a band and ignores bins past the end of the data", () => {
    const frequency = new Uint8Array([0, 255, 255, 0, 0]);

    expect(bandLevel(frequency, [1, 3])).toBe(1);
    expect(bandLevel(frequency, [3, 5])).toBe(0);
    expect(bandLevel(frequency, [4, 400])).toBe(0);
    expect(bandLevel(frequency, [9, 12])).toBe(0);
  });
});
