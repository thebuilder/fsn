/** Inclusive-exclusive bin range for one band. */
export type Band = [number, number];

/**
 * Splits the spectrum into equal-octave bands, the way hearing divides it. Linear
 * bins would spend most of the display on treble nobody notices and leave the bass
 * in a single column.
 *
 * Note that this deliberately gives the low end plenty of bands: at the bottom the
 * ratio between neighbours is under one bin, so those bands are a single bin wide.
 * That is right for a spectrum display, where a loud low end is information. Anything
 * mapping these to *shape* has to reckon with the fact that low bins sit pegged at
 * full scale for the whole of a loud passage.
 */
export function logBands(count: number, topBin: number): Band[] {
  const bands: Band[] = [];
  let previous = 1;
  for (let index = 1; index <= count; index += 1) {
    const edge = Math.round(topBin ** (index / count));
    const to = Math.max(previous + 1, Math.min(edge, topBin));
    bands.push([previous, to]);
    previous = to;
  }
  return bands;
}

/** Mean magnitude across a band, 0-1. */
export function bandLevel(frequency: Uint8Array, band: Band): number {
  const [from, to] = band;
  const end = Math.min(to, frequency.length);
  if (end <= from) return 0;
  let sum = 0;
  for (let bin = from; bin < end; bin += 1) sum += frequency[bin];
  return sum / (end - from) / 255;
}
