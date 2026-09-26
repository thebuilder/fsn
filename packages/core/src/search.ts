import type { FsNode } from "./filesystem";

/**
 * One object a tree index has seen, carrying everything a query needs so that ranking
 * never has to walk the tree again.
 *
 * The keys are folded once, here, rather than on every keystroke: a query over tens of
 * thousands of entries is then a string comparison per entry and nothing else. Folding
 * normalises to NFC as well as lower-casing, because macOS hands names back decomposed
 * (`é` as `e` plus a combining accent) and a query typed on the same machine arrives
 * composed — without it, `café` would never find `Café`.
 */
export type IndexedObject = {
  node: FsNode;
  /** Directory chain from the root down to the object's parent. Shared by siblings. */
  trail: readonly FsNode[];
  /** Where the object lives below the root, `/`-joined without the root's own name: `Projects/src/scene.ts`. */
  path: string;
  /** The folded name, compared against a query with no separator in it. */
  nameKey: string;
  /** The folded path with a leading `/`, compared against a query that has one. */
  pathKey: string;
};

export type IndexSearchOutcome = {
  matches: IndexedObject[];
  /** Every entry that matched, including those trimmed off by the limit. */
  total: number;
};

export function foldForSearch(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/**
 * Index entries for one directory's children. `trail` ends at that directory, and the
 * children share it (and the parent's path) rather than each copying their own.
 */
export function indexChildren(trail: readonly FsNode[], children: readonly FsNode[]): IndexedObject[] {
  const parentPath = trail.slice(1).map((part) => part.name).join("/");
  const parentKey = foldForSearch(parentPath);
  return children.map((node) => {
    const nameKey = foldForSearch(node.name);
    return {
      node,
      trail,
      path: parentPath ? `${parentPath}/${node.name}` : node.name,
      nameKey,
      pathKey: parentKey ? `/${parentKey}/${nameKey}` : `/${nameKey}`,
    };
  });
}

/** Where the object is kept, below the root: `/Projects/src` for `Projects/src/scene.ts`, `/` at the top. */
export function locationOf(entry: IndexedObject): string {
  const cut = entry.path.length - entry.node.name.length - 1;
  return cut > 0 ? `/${entry.path.slice(0, cut)}` : "/";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Ranks the index against a query, nearest and best-matching first.
 *
 * The order is a promise about where you are standing before it is one about the
 * text. Objects in the directory you are in come first, because they are the ones on
 * screen and the ones most likely meant; after that, how well the name matches (the
 * whole prefix, then the start of a word, then anywhere); then whether the object is
 * somewhere below you rather than elsewhere in the tree; then how shallow it is, with
 * directories ahead of files and the name itself as the last word. The first four keys
 * are packed into one number so the common comparison never reaches the collator.
 *
 * A query containing `/` is matched against the whole path instead of the name, so
 * `fsn/src` finds that directory and everything inside it without also finding every
 * other `src`. Only the best `limit` are kept, by insertion, so a one-letter query over
 * the whole tree never sorts the whole tree.
 */
export function searchIndex(
  entries: readonly IndexedObject[],
  query: string,
  options: { limit: number; here?: string },
): IndexSearchOutcome {
  const folded = foldForSearch(query.trim());
  if (!folded || options.limit <= 0) return { matches: [], total: 0 };
  const byPath = folded.includes("/");
  const top: { entry: IndexedObject; score: number }[] = [];
  let total = 0;

  for (const entry of entries) {
    const quality = byPath ? pathQuality(entry.pathKey, folded) : nameQuality(entry.nameKey, folded);
    if (quality < 0) continue;
    total += 1;
    const score = scoreOf(entry, quality, options.here);
    if (top.length === options.limit && compare(score, entry, top[top.length - 1]) >= 0) continue;
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compare(score, entry, top[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    top.splice(low, 0, { entry, score });
    if (top.length > options.limit) top.pop();
  }

  return { matches: top.map((ranked) => ranked.entry), total };
}

function compare(score: number, entry: IndexedObject, other: { entry: IndexedObject; score: number }): number {
  return score - other.score || collator.compare(entry.node.name, other.entry.node.name);
}

function scoreOf(entry: IndexedObject, quality: number, here: string | undefined): number {
  const parent = entry.trail[entry.trail.length - 1];
  const local = here !== undefined && parent?.id === here ? 0 : 1;
  const below = here !== undefined && entry.trail.some((part) => part.id === here) ? 0 : 1;
  const depth = Math.min(entry.trail.length, 999);
  const file = entry.node.kind === "directory" ? 0 : 1;
  return local * 1e7 + quality * 1e6 + below * 1e5 + depth * 10 + file;
}

/** 0 for a whole-prefix match, 1 for one at the start of a word, 2 anywhere, -1 for none. */
function nameQuality(name: string, query: string): number {
  const index = name.indexOf(query);
  if (index < 0) return -1;
  if (index === 0) return 0;
  if (wordBoundary.test(name[index - 1])) return 1;
  // A later occurrence can still start a word even when the first one does not.
  for (let next = name.indexOf(query, index + 1); next > 0; next = name.indexOf(query, next + 1)) {
    if (wordBoundary.test(name[next - 1])) return 1;
  }
  return 2;
}

/** 0 when the path ends with the query, 1 when it starts at a separator, 2 anywhere, -1 for none. */
function pathQuality(path: string, query: string): number {
  if (!path.includes(query)) return -1;
  if (path.endsWith(query)) return 0;
  return query.startsWith("/") || path.includes(`/${query}`) ? 1 : 2;
}

const wordBoundary = /[\s._\-/()[\]]/;
