import { describe, expect, it } from "vitest";
import type { FileCategory, FsNode } from "@fsn/core";
import { buildLayout, plotBox, seededHash, shelfPack, towerBox } from "./layout";

let nextId = 0;

/** A minimal FsNode built from a real extension, so `categoryOf` resolves it deterministically. */
function fakeNode(name: string, size: number, kind: "file" | "directory" = "file", peekTotal?: number): FsNode {
  nextId += 1;
  const node: FsNode = { id: `${name}-${nextId}`, parentId: "root", name, kind, size };
  if (kind === "directory" && peekTotal !== undefined) {
    const rotation: FileCategory[] = ["code", "image", "audio", "document"];
    node.peek = {
      total: peekTotal,
      categories: Array.from({ length: Math.min(peekTotal, 64) }, (_, index) => rotation[index % rotation.length]),
    };
  }
  return node;
}

/** Fixed, non-random spread of sizes so a "varied" input set never depends on Math.random. */
const FIXED_SIZES = [1.2, 3.4, 0.8, 2.1, 4.6, 1.9, 3.0, 0.5, 2.7, 1.4, 3.8, 2.2, 1.1, 4.0, 0.9, 2.5, 3.3, 1.7, 2.9, 0.6, 3.6, 1.0, 2.4, 4.2];

function fixedFootprints(count: number): { width: number; depth: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    width: FIXED_SIZES[index % FIXED_SIZES.length],
    depth: FIXED_SIZES[(index + 7) % FIXED_SIZES.length],
  }));
}

/** AABB overlap test on rectangles centred at (x, z) with the given width/depth. */
function overlaps(
  a: { x: number; z: number; width: number; depth: number },
  b: { x: number; z: number; width: number; depth: number },
): boolean {
  const EPS = 1e-9;
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 - EPS && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 - EPS;
}

function mixedNodes(): FsNode[] {
  return [
    fakeNode("src", 0, "directory", 12),
    fakeNode("assets", 0, "directory", 3),
    fakeNode("index.ts", 4_096),
    fakeNode("app.ts", 18_000),
    fakeNode("logo.png", 240_000),
    fakeNode("icon.png", 12_000),
    fakeNode("theme.mp3", 2_500_000),
    fakeNode("empty-dir", 0, "directory", 0),
  ];
}

describe("shelfPack", () => {
  it("never overlaps two placed rectangles", () => {
    const items = fixedFootprints(30);
    const { placed } = shelfPack(items, 0.5, 12);

    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = { x: placed[i].x, z: placed[i].z, width: placed[i].item.width, depth: placed[i].item.depth };
        const b = { x: placed[j].x, z: placed[j].z, width: placed[j].item.width, depth: placed[j].item.depth };
        expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it("keeps every placed rectangle inside the returned width/depth", () => {
    const items = fixedFootprints(24);
    const result = shelfPack(items, 0.7, 9);
    const EPS = 1e-9;

    for (const p of result.placed) {
      expect(Math.abs(p.x) + p.item.width / 2).toBeLessThanOrEqual(result.width / 2 + EPS);
      expect(Math.abs(p.z) + p.item.depth / 2).toBeLessThanOrEqual(result.depth / 2 + EPS);
    }
  });
});

describe("buildLayout", () => {
  it("returns exactly one placement per node", () => {
    const nodes = mixedNodes();
    const layout = buildLayout(nodes);
    expect(layout.placements).toHaveLength(nodes.length);
  });

  it("returns the documented defaults for an empty directory", () => {
    expect(buildLayout([])).toEqual({ placements: [], radius: 16, groundWidth: 22, groundDepth: 18, peakHeight: 2 });
  });

  it("is deterministic: the same node list produces deeply-equal placements", () => {
    const nodes = mixedNodes();
    const first = buildLayout(nodes);
    const second = buildLayout(nodes);
    expect(first.placements).toEqual(second.placements);
    expect(first).toEqual(second);
  });

  it("keeps every placement inside the ground rectangle, with radius covering the furthest one", () => {
    const nodes = mixedNodes();
    const layout = buildLayout(nodes);
    const EPS = 1e-6;

    for (const placement of layout.placements) {
      expect(Math.abs(placement.position.x)).toBeLessThanOrEqual(layout.groundWidth / 2 + EPS);
      expect(Math.abs(placement.position.z)).toBeLessThanOrEqual(layout.groundDepth / 2 + EPS);
    }

    const furthest = Math.max(...layout.placements.map((p) => Math.hypot(p.position.x, p.position.z)));
    expect(layout.radius).toBeGreaterThanOrEqual(furthest);
  });

  it("sizes a directory's footprint by how much it holds", () => {
    const sparse = plotBox(fakeNode("a", 0, "directory", 2));
    const dense = plotBox(fakeNode("a", 0, "directory", 60));
    expect(sparse.width !== dense.width || sparse.depth !== dense.depth).toBe(true);
  });
});

describe("seededHash", () => {
  it("is a pure function of its input", () => {
    expect(seededHash("same-id")).toBe(seededHash("same-id"));
  });
});

describe("towerBox", () => {
  it("grows taller for a larger file, staying pure across calls", () => {
    const small = towerBox(fakeNode("small.ts", 1_024));
    const large = towerBox(fakeNode("large.ts", 10_000_000));
    expect(large.height).toBeGreaterThan(small.height);
  });
});
