import {
  AGE_BUCKETS,
  ageBucketIndex,
  usageOfLoadedTree,
  type FsKind,
  type FsNode,
  type GitLensState,
  type GitStatusIndex,
} from "@fsn/core";
import type { DirectorySize } from "./layout";

/**
 * Lenses: alternative readings of the same city. The layout never changes with a colour
 * lens — only what each object is painted — so switching one is a recolour of instances
 * that already exist, not a rebuild. The size lens does move things, because it changes
 * what a plot's height means, and it goes through the layout like any other input.
 */
export type ColourMode = "type" | "age" | "git";

export type LensChoice = { size: DirectorySize; colour: ColourMode };

export const DEFAULT_LENS: LensChoice = { size: "own", colour: "type" };

/**
 * What a colour lens tells the scene. Null from either method means "no opinion", and the
 * scene falls back to the type palette, which is also how the type lens is spelled: it is
 * simply the absence of any other.
 */
export type ColourLens = {
  colorFor(node: FsNode): number | null;
  /** The colour for the marker that stands for child `index` of `directory`'s peek. */
  markerColorFor(directory: FsNode, index: number): number | null;
};

/**
 * Hot to cold, one per `AGE_BUCKETS` entry. A heat ramp rather than a single hue fading
 * out, because the scene is lit by cyan-tinted lights over a near-black floor: a fade to
 * dark would lose the old half of the ramp into the ground, while a walk through the hues
 * keeps every bucket distinct and still lit.
 *
 * These are what the scene is given, not what it shows. The same cyan light that starves
 * the type palette's red pulls every warm hue towards green — a literal yellow renders as
 * a sour lime — so the warm end is handed over redder than it should read, the way the
 * type palette's image orange is. The legend gets the colours as seen, in `AGE_SWATCHES`.
 */
export const AGE_COLORS: readonly number[] = [0xffab12, 0xff6a1a, 0xff2d3c, 0xd83a9a, 0x7a52e0, 0x2a64d0];
/** The legend's rendering of `AGE_COLORS`, matched to how they come out under the lights. */
export const AGE_SWATCHES: readonly number[] = [0xffd84a, 0xff9a3a, 0xff4b4b, 0xe0509e, 0x8a66f0, 0x3d78e0];
/** No timestamp to go on: grey, so it reads as absent rather than as old. */
export const AGE_UNKNOWN_COLOR = 0x56615f;

/**
 * Status colours. Changes take the warm, loud end; clean work is a neutral grey that
 * recedes, and ignored files are dimmed almost into the floor, since they are the part of
 * the tree git has been told to look away from.
 */
export const GIT_COLORS: Readonly<Record<GitLensState, number>> = {
  conflicted: 0xff3d7f,
  // Pre-compensated like the age ramp's warm end, so modified reads amber, not olive.
  modified: 0xff9a1f,
  deleted: 0xff6a4a,
  added: 0x5cf08a,
  untracked: 0x57c7ff,
  ignored: 0x24302f,
  clean: 0x74827f,
};

export type LegendRow = { label: string; color: number };

/** Legend rows for a colour lens, in the order they should read. The type lens keeps its own. */
export function legendFor(mode: Exclude<ColourMode, "type">): { title: string; rows: LegendRow[] } {
  if (mode === "age") {
    return {
      title: "LAST CHANGED",
      rows: [...AGE_BUCKETS.map((bucket, index) => ({ label: bucket.label, color: AGE_SWATCHES[index] })), { label: "Unknown", color: AGE_UNKNOWN_COLOR }],
    };
  }
  return {
    title: "GIT STATUS",
    rows: [
      { label: "Conflicted", color: GIT_COLORS.conflicted },
      { label: "Modified", color: 0xffb347 },
      { label: "Added", color: GIT_COLORS.added },
      { label: "Untracked", color: GIT_COLORS.untracked },
      { label: "Clean", color: GIT_COLORS.clean },
      { label: "Ignored", color: GIT_COLORS.ignored },
    ],
  };
}

export function ageColor(modified: number | undefined, now: number): number {
  const index = ageBucketIndex(modified, now);
  return index === null ? AGE_UNKNOWN_COLOR : AGE_COLORS[index];
}

/**
 * The child a plot's marker stands for, as far as the directory's listing can say, with
 * the child's own node when it has been read.
 */
export function markerChild(directory: FsNode, index: number): { name?: string; modified?: number; kind: FsKind; node?: FsNode } {
  const peek = directory.peek;
  const kind: FsKind = peek?.categories[index] === "directory" ? "directory" : "file";
  const name = peek?.names?.[index];
  if (name === undefined) {
    // A peek without names was built from the children themselves, in the same order.
    const child = directory.children?.[index];
    return { name: child?.name, modified: child?.modified, kind, node: child };
  }
  // A browser peek cannot afford timestamps, but the children may have been read since.
  const child = directory.children?.find((candidate) => candidate.name === name);
  return { name, modified: peek?.modified?.[index] ?? child?.modified, kind, node: child };
}

/** How much of an in-memory tree an age lens will look through to date one folder. */
const RECENCY_WALK_LIMIT = 20_000;

/**
 * When a directory last changed, as far as anything has looked: the newest file a
 * measurement found beneath it, else the newest among whatever of its tree is already in
 * memory, else its own timestamp — which only moves when entries are added or removed
 * directly inside it, so it is the weakest of the three. The in-memory walk is bounded
 * and remembered for the life of the lens, since a repaint asks for every folder again.
 */
function recencyReader(): (node: FsNode) => number | undefined {
  const loaded = new WeakMap<FsNode, number | undefined>();
  return (node) => {
    if (node.usage?.newest !== undefined) return node.usage.newest;
    if (!loaded.has(node)) loaded.set(node, node.children ? usageOfLoadedTree(node, RECENCY_WALK_LIMIT).newest : undefined);
    return loaded.get(node) ?? node.modified;
  };
}

export function createAgeLens(now: number): ColourLens {
  const recency = recencyReader();
  return {
    colorFor: (node) => ageColor(node.kind === "directory" ? recency(node) : node.modified, now),
    markerColorFor: (directory, index) => {
      const child = markerChild(directory, index);
      return ageColor(child.node?.kind === "directory" ? recency(child.node) : child.modified, now);
    },
  };
}

/**
 * `pathOf` turns a node into its path below the open folder, as names; null when the
 * navigator no longer knows where the node lives, in which case the lens stays quiet.
 */
export function createGitLens(status: GitStatusIndex, pathOf: (node: FsNode) => string[] | null): ColourLens {
  return {
    colorFor: (node) => {
      const segments = pathOf(node);
      return segments ? GIT_COLORS[status.stateAt(segments, node.kind)] : null;
    },
    markerColorFor: (directory, index) => {
      const segments = pathOf(directory);
      const child = markerChild(directory, index);
      if (!segments || child.name === undefined) return null;
      return GIT_COLORS[status.stateAt([...segments, child.name], child.kind)];
    },
  };
}

const LENS_STORAGE_KEY = "fsn.lens";

/**
 * The lens a viewer chose last time. Storage is a convenience here, never a dependency:
 * a private window, blocked site data or a value written by some older build all come
 * back as the default rather than as an error.
 */
export function readLensChoice(storage: Pick<Storage, "getItem"> | null): LensChoice {
  try {
    const raw = storage?.getItem(LENS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LENS };
    const parsed = JSON.parse(raw) as Partial<LensChoice> | null;
    return {
      size: parsed?.size === "total" ? "total" : "own",
      colour: parsed?.colour === "age" || parsed?.colour === "git" ? parsed.colour : "type",
    };
  } catch {
    return { ...DEFAULT_LENS };
  }
}

export function writeLensChoice(storage: Pick<Storage, "setItem"> | null, choice: LensChoice): void {
  try {
    storage?.setItem(LENS_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Unwritable storage only costs the choice being remembered.
  }
}

/** `window.localStorage` itself throws in some privacy modes, so even asking for it is guarded. */
export function lensStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
