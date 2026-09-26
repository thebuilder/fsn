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
 *
 * An object in that directory can ride along after it, as `?select=<name>`, with `&view`
 * when its viewer window is open: `#/Macintosh%20HD/Logs?select=boot.log&view`. The path
 * cannot carry it as one more segment, because a selected sub-directory would then read
 * exactly like having walked into it, and it would have to be told apart from a file by
 * reading the disk. A query is the shape the address bar already means "this place, with
 * this detail" by, and it cannot collide with a name: every segment and the selected name
 * are written with `encodeURIComponent`, which escapes `?`, `=`, `&`, `/` and `#`, so a
 * raw `?select=` only ever appears where this module put it. Fragments written before the
 * object existed hold no such marker and read exactly as they always did — including a
 * hand-typed stray `?`, which is left inside the name it was typed into.
 */

/** An object inside the addressed directory, by name, and whether its viewer is open. */
export type RouteObject = { name: string; viewing: boolean };

export type Route = {
  /** Directory names from the root down. Empty when the fragment addresses nothing. */
  names: string[];
  object: RouteObject | null;
};

const objectMarker = "?select=";
const viewingFlag = "view";

/**
 * Directory names from the root down, as a fragment: `#/Macintosh HD/Documents`, and the
 * object selected there when there is one: `#/Macintosh HD/Documents?select=notes.md`.
 */
export function routeFor(names: string[], object?: RouteObject | null): string {
  const path = `#/${names.map(encodeSegment).join("/")}`;
  if (!object || names.length === 0) return path;
  return `${path}${objectMarker}${encodeSegment(object.name)}${object.viewing ? `&${viewingFlag}` : ""}`;
}

/** Where a fragment points. Parts it cannot make sense of are dropped, never thrown. */
export function readRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const marker = raw.indexOf(objectMarker);
  const path = marker < 0 ? raw : raw.slice(0, marker);
  const names = path.split("/").filter(Boolean).map(decodeSegment);
  if (marker < 0 || names.length === 0) return { names, object: null };
  const [selected, ...flags] = raw.slice(marker + objectMarker.length).split("&");
  if (!selected) return { names, object: null };
  return { names, object: { name: decodeSegment(selected), viewing: flags.includes(viewingFlag) } };
}

export function sameRoute(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function sameObject(a: RouteObject | null, b: RouteObject | null): boolean {
  return a === b || (a !== null && b !== null && a.name === b.name && a.viewing === b.viewing);
}

/**
 * `encodeURIComponent` throws on a lone surrogate, which a Windows file name can hold.
 * Such a name is written with the replacement character instead: the address will not
 * find it again, but navigating into or selecting it must not throw on the way.
 */
function encodeSegment(name: string): string {
  try {
    return encodeURIComponent(name);
  } catch {
    return encodeURIComponent(name.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�"));
  }
}

/** A hand-edited fragment can hold a stray percent; take such a segment literally. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
