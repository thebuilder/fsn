/**
 * The directory you are standing in, written into the address bar.
 *
 * It lives in the location fragment rather than the path, because a fragment is what
 * this honestly is: a place inside the document already loaded, not a resource a server
 * could ever hand back. The names are relative to whichever source is mounted, and the
 * browser grants access to handles rather than to locations, so `/Documents/Field Notes`
 * only means anything alongside the folder this visitor has already been given.
 *
 * Keeping it out of the path is also what makes a reload work everywhere without a rule
 * to make it work: no rewrite on the host, none in the Tauri asset protocol, and one
 * canonical URL for the one page there has ever been.
 */

/** Directory names from the root down, as a fragment: `#/Macintosh HD/Documents`. */
export function routeFor(names: string[]): string {
  return `#/${names.map(encodeURIComponent).join("/")}`;
}

/** The names a fragment addresses, root first. Empty when it addresses nothing. */
export function readRoute(hash: string): string[] {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw.split("/").filter(Boolean).map(decodeSegment);
}

export function sameRoute(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** A hand-edited fragment can hold a stray percent; take such a segment literally. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
