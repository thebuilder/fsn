import * as THREE from "three";
import { categoryOf, type FileCategory, type FsNode } from "@fsn/core";

/**
 * The layout engine: pure functions that decide where things stand. Given a directory
 * listing, they hash, pack, and box it into stable district geometry — one placement per
 * node, positioned, sized, and timed for its entrance — without touching a scene graph,
 * the DOM, or `this`. `scene.ts` takes that geometry and decides how it looks.
 */

export type Placement = {
  node: FsNode;
  position: THREE.Vector3;
  scale: THREE.Vector3;
  /** Box the selection and aim outlines wrap. Encloses a plot's markers, not just its slab. */
  outlinePosition: THREE.Vector3;
  outlineScale: THREE.Vector3;
  /** Height at which a label clears this object and whatever stands on it. */
  labelY: number;
  /** How much of `labelY` is the row's lane stagger, so growth can stretch it. */
  labelLift: number;
  /** Milliseconds into the reveal before this object starts to rise. */
  introDelay: number;
  /** Set once the instanced mesh exists, so hover can address this one instance. */
  mesh?: THREE.InstancedMesh;
  instanceIndex?: number;
  /** Preview markers standing on a directory plot. Never picked; they ride with it. */
  decor: Decor[];
  /** Built on demand the first time this object is close enough on screen to name. */
  label?: THREE.Sprite;
};

/** One preview marker on a directory plot. Decoration only: not selectable, not a node. */
export type Decor = {
  category: FileCategory;
  position: THREE.Vector3;
  scale: THREE.Vector3;
  mesh?: THREE.InstancedMesh;
  instanceIndex?: number;
};

export type AreaLayout = {
  placements: Placement[];
  radius: number;
  groundWidth: number;
  groundDepth: number;
  /** Top of the tallest thing standing here, including its label. */
  peakHeight: number;
};

/** The district floor: one slab per directory, with everything inside standing on it. */
export const GROUND_HEIGHT = 0.5;
export const GROUND_Y = -0.12;
export const GROUND_TOP = GROUND_Y + GROUND_HEIGHT / 2;
/** Bare floor around the outermost block, proportional so a small district is not a plinth. */
const GROUND_MARGIN_RATIO = 0.16;
const GROUND_MARGIN_MIN = 2.6;
const GROUND_MARGIN_MAX = 6.5;

/** Towers pack tight within a block; blocks are separated by a street. */
/**
 * A little over one tower wide. Tighter than this and a block of same-coloured towers
 * fuses into a single mass from any angle low enough to see the skyline.
 */
const TOWER_GAP = 1.7;
const PLOT_GAP = 1.7;
const BLOCK_AISLE = 3.8;

/**
 * Every step through a block — back a row or along one — carries a label a lane higher,
 * so neither the neighbour behind nor the one beside prints at the same height. Stepping
 * back is what stops a label hiding behind the row in front. Stepping along used to be
 * unnecessary, because `TOWER_GAP` spaces towers further apart than a label is wide, but
 * only just: a label that grows to stay readable at distance eats that margin
 * immediately, and without a lane of its own each name in a row would take the space of
 * the one beside it.
 *
 * The lane cycles rather than climbing. Only immediate neighbours can overlap on screen
 * — anything further is already separated by perspective — so a few distinct heights is
 * all it takes. Left to accumulate, a directory deep enough to need ten rows would leave
 * its back labels floating ten units over their towers, attached to nothing. Three lanes
 * cannot also separate both diagonals; those are the widest-spaced neighbours of the
 * eight, and the picker turns down whichever pair still meets on screen.
 */
const LABEL_LANE = 1;
const LABEL_LANE_CYCLE = 3;

/** A directory is a low plot of land carrying one marker per child. */
const PLOT_HEIGHT = 0.62;
const PLOT_TOP = GROUND_TOP + PLOT_HEIGHT;
const PLOT_PADDING = 1.05;
const PLOT_MIN_WIDTH = 4.2;
const MARKER_CELL = 1;
const MARKER_FOOTPRINT = 0.6;
const MARKER_HEIGHT = 1.15;
const MARKER_MAX_COLUMNS = 6;

/** Blocks are laid out in this order, so a directory's shape is stable across visits. */
const CATEGORY_ORDER: FileCategory[] = [
  "directory", "code", "document", "image", "audio", "video", "model", "font", "archive", "system", "unknown",
];

/** Milliseconds the reveal ripples outward across; paired with INTRO_RISE in scene.ts. */
const INTRO_STAGGER = 460;

export function seededHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

/** Spread-free max so a directory of any size cannot overflow the call stack. */
function maxOf<T>(items: readonly T[], value: (item: T) => number, floor: number): number {
  let max = floor;
  for (const item of items) max = Math.max(max, value(item));
  return max;
}

type Footprint = { width: number; depth: number };
type Marker = { category: FileCategory; x: number; z: number };
type Box = Footprint & { node: FsNode; height: number; markers: Marker[] };
/** `lane` counts steps back and along from the front left of the pack, for label stacking. */
type Placed<T> = { item: T; x: number; z: number; lane: number };

/** Comparator that restores the order items arrived in, captured before any sorting. */
function byListing(boxes: Box[]): (a: Box, b: Box) => number {
  const rank = new Map(boxes.map((box, index) => [box.node.id, index]));
  return (a, b) => (rank.get(a.node.id) ?? 0) - (rank.get(b.node.id) ?? 0);
}
type PackResult<T> = { placed: Placed<T>[]; width: number; depth: number };

/**
 * Flows items left to right into rows no wider than `limit`, then centres each row on
 * the origin. A row is only as deep as its own deepest item, so a block of towers stays
 * tight instead of inheriting the largest footprint in the directory.
 *
 * Items arrive sorted tallest first, which fills the rows back to front, and `orderInRow`
 * then restores the caller's reading order across each row. The result steps down towards
 * the camera — nothing tall stands in front of anything short — while each row still
 * reads left to right in listing order.
 */
export function shelfPack<T extends Footprint>(
  items: T[],
  gap: number,
  limit: number,
  orderInRow?: (a: T, b: T) => number,
): PackResult<T> {
  const rows: { items: T[]; width: number; depth: number }[] = [];
  for (const item of items) {
    let row = rows[rows.length - 1];
    if (!row || row.width + gap + item.width > limit) {
      row = { items: [], width: 0, depth: 0 };
      rows.push(row);
    }
    if (row.items.length) row.width += gap;
    row.items.push(item);
    row.width += item.width;
    row.depth = Math.max(row.depth, item.depth);
  }

  if (orderInRow) rows.forEach((row) => row.items.sort(orderInRow));

  const width = maxOf(rows, (row) => row.width, 0);
  const depth = rows.reduce((total, row) => total + row.depth, 0) + gap * Math.max(rows.length - 1, 0);
  const placed: Placed<T>[] = [];
  let z = -depth / 2;
  rows.forEach((row, index) => {
    let x = -row.width / 2;
    row.items.forEach((item, column) => {
      // Along the row as well as back through them: see `LABEL_LANE`.
      const lane = rows.length - 1 - index + column;
      placed.push({ item, x: x + item.width / 2, z: z + row.depth / 2, lane });
      x += item.width + gap;
    });
    z += row.depth + gap;
  });
  return { placed, width, depth };
}

/** A row width that lands the pack near `aspect`:1 rather than one long corridor. */
function packWidth(items: Footprint[], gap: number, aspect: number): number {
  const area = items.reduce((total, item) => total + (item.width + gap) * (item.depth + gap), 0);
  return Math.max(maxOf(items, (item) => item.width, 1), Math.sqrt(area * aspect));
}

/** A file is a tower: footprint roughly constant, height from its size on disk. */
export function towerBox(node: FsNode): Box {
  const jitter = seededHash(node.id);
  return {
    node,
    width: 1.45 + (jitter % 4) * 0.1,
    depth: 1.45,
    height: Math.max(0.55, Math.min(7, Math.log2((node.size ?? 1_024) / 1024 + 1) * 0.62)),
    markers: [],
  };
}

/**
 * A directory is a plot of land: its area grows with how much it holds, and it carries
 * one marker per child, coloured by that child's type. The markers are all the same
 * height on purpose — sizes inside a directory are not known without opening every file
 * in it, and a varied skyline would be encoding data that was never read.
 */
export function plotBox(node: FsNode): Box {
  const peek = node.peek;
  const total = peek?.total ?? node.children?.length ?? 0;
  const columns = THREE.MathUtils.clamp(Math.round(Math.sqrt(total)), 1, MARKER_MAX_COLUMNS);
  const rows = THREE.MathUtils.clamp(Math.ceil(total / columns), 1, MARKER_MAX_COLUMNS);
  const shown = Math.min(total, columns * rows);

  const markers: Marker[] = [];
  for (let index = 0; index < shown; index += 1) {
    markers.push({
      category: peek?.categories[index] ?? "unknown",
      x: ((index % columns) - (columns - 1) / 2) * MARKER_CELL,
      z: (Math.floor(index / columns) - (rows - 1) / 2) * MARKER_CELL,
    });
  }

  return {
    node,
    width: Math.max(PLOT_MIN_WIDTH, columns * MARKER_CELL + PLOT_PADDING * 2),
    depth: Math.max(PLOT_MIN_WIDTH * 0.8, rows * MARKER_CELL + PLOT_PADDING * 2),
    height: PLOT_HEIGHT,
    markers,
  };
}

function toPlacement(box: Box, x: number, z: number, labelLift: number): Placement {
  const decor = box.markers.map((marker) => ({
    category: marker.category,
    position: new THREE.Vector3(x + marker.x, PLOT_TOP + MARKER_HEIGHT / 2, z + marker.z),
    scale: new THREE.Vector3(MARKER_FOOTPRINT, MARKER_HEIGHT, MARKER_FOOTPRINT),
  }));
  const outlineHeight = box.markers.length ? PLOT_HEIGHT + MARKER_HEIGHT : box.height;
  return {
    node: box.node,
    position: new THREE.Vector3(x, GROUND_TOP + box.height / 2, z),
    scale: new THREE.Vector3(box.width, box.height, box.depth),
    outlinePosition: new THREE.Vector3(x, GROUND_TOP + outlineHeight / 2, z),
    outlineScale: new THREE.Vector3(box.width, outlineHeight, box.depth),
    labelY: labelLift + (box.markers.length ? PLOT_TOP + MARKER_HEIGHT + 0.95 : GROUND_TOP + box.height + 0.82),
    labelLift,
    introDelay: 0,
    decor,
  };
}

/**
 * Lays a directory out as a city block plan on one shared floor. Objects of the same
 * category are packed together into a block and the blocks are flowed across the
 * district with streets between them, so the palette reads as neighbourhoods rather
 * than as scattered confetti — and so a plot's size is the only thing on screen that
 * varies with what a directory actually holds.
 */
export function buildLayout(nodes: FsNode[]): AreaLayout {
  if (!nodes.length) return { placements: [], radius: 16, groundWidth: 22, groundDepth: 18, peakHeight: 2 };

  const byCategory = new Map<FileCategory, FsNode[]>();
  for (const node of nodes) {
    const category = categoryOf(node);
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(node);
    else byCategory.set(category, [node]);
  }

  const blocks = CATEGORY_ORDER.flatMap((category, categoryRank) => {
    const members = byCategory.get(category);
    if (!members) return [];
    const isDirectory = category === "directory";
    const boxes = members.map((node) => (isDirectory ? plotBox(node) : towerBox(node)));
    const gap = isDirectory ? PLOT_GAP : TOWER_GAP;
    // Tallest to the back, then alphabetical across each row. Plots are all the same
    // low height, so for those the height sort is a no-op and listing order stands.
    const rowOrder = byListing(boxes);
    boxes.sort((a, b) => b.height - a.height);
    const packed = shelfPack(boxes, gap, packWidth(boxes, gap, 1.5), rowOrder);
    return [{
      packed,
      width: packed.width,
      depth: packed.depth,
      categoryRank,
      peak: maxOf(boxes, (box) => box.height, -Infinity),
    }];
  });

  // The same rule one level up: a block of tall towers goes behind the short ones so it
  // cannot wall off the district, while each row still runs in category order.
  const blockOrder = (a: typeof blocks[number], b: typeof blocks[number]) => a.categoryRank - b.categoryRank;
  blocks.sort((a, b) => b.peak - a.peak);
  const district = shelfPack(blocks, BLOCK_AISLE, packWidth(blocks, BLOCK_AISLE, 1.7), blockOrder);
  const placements = district.placed.flatMap(({ item: block, x: blockX, z: blockZ, lane: blockLane }) =>
    block.packed.placed.map(({ item: box, x, z, lane }) =>
      toPlacement(box, blockX + x, blockZ + z, ((blockLane + lane) % LABEL_LANE_CYCLE) * LABEL_LANE)));

  // Ripple the reveal outwards from the centre, capped so a huge directory
  // takes no longer to land than a small one.
  const furthest = maxOf(placements, (p) => Math.hypot(p.position.x, p.position.z), 1);
  placements.forEach((placement) => {
    placement.introDelay = (Math.hypot(placement.position.x, placement.position.z) / furthest) * INTRO_STAGGER;
  });

  const margin = THREE.MathUtils.clamp(
    Math.max(district.width, district.depth) * GROUND_MARGIN_RATIO,
    GROUND_MARGIN_MIN,
    GROUND_MARGIN_MAX,
  );
  const groundWidth = district.width + margin * 2;
  const groundDepth = district.depth + margin * 2;
  return {
    placements,
    radius: Math.hypot(groundWidth, groundDepth) / 2 + 6,
    groundWidth,
    groundDepth,
    peakHeight: maxOf(placements, (p) => p.labelY, 0),
  };
}
