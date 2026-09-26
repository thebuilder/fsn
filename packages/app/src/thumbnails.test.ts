import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { FsNode } from "@fsn/core";
import type { Placement } from "./layout";
import {
  fitToRoof,
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_LIMIT,
  THUMBNAIL_MAX_BYTES,
  ThumbnailLoader,
  thumbnailCandidates,
  wantsThumbnail,
} from "./thumbnails";

function file(name: string, size?: number): FsNode {
  return { id: name, parentId: "root", name, kind: "file", size };
}

function placementAt(node: FsNode, x: number): Placement {
  return {
    node,
    position: new THREE.Vector3(x, 1, 0),
    scale: new THREE.Vector3(1.2, 2, 1.2),
    outlinePosition: new THREE.Vector3(x, 1, 0),
    outlineScale: new THREE.Vector3(1.2, 2, 1.2),
    labelY: 3,
    labelLift: 0,
    introDelay: 0,
    decor: [],
  };
}

describe("wantsThumbnail", () => {
  it("takes the raster images a browser can decode from bytes", () => {
    expect(wantsThumbnail(file("coast.webp", 80_000))).toBe(true);
    expect(wantsThumbnail(file("sheet.PNG", 80_000))).toBe(true);
    expect(wantsThumbnail(file("unknown-size.jpg"))).toBe(true);
  });

  it("leaves everything else with a plain roof", () => {
    expect(wantsThumbnail(file("notes.txt", 10))).toBe(false);
    expect(wantsThumbnail({ id: "d", parentId: null, name: "Pictures.png", kind: "directory" })).toBe(false);
    // Vector images need a document to become pixels, and untrusted bytes never get one.
    expect(wantsThumbnail(file("logo.svg", 2_000))).toBe(false);
    expect(wantsThumbnail(file("scan.tiff", 2_000))).toBe(false);
  });

  it("skips a file too large to be worth reading", () => {
    expect(wantsThumbnail(file("panorama.jpg", THUMBNAIL_MAX_BYTES + 1))).toBe(false);
    expect(wantsThumbnail(file("panorama.jpg", THUMBNAIL_MAX_BYTES))).toBe(true);
  });
});

describe("thumbnailCandidates", () => {
  it("puts the nearest images first and leaves out everything else", () => {
    const placements = [
      placementAt(file("far.png", 10), 40),
      placementAt(file("readme.md", 10), 1),
      placementAt(file("near.png", 10), 2),
      placementAt(file("middle.png", 10), 20),
    ];
    const names = thumbnailCandidates(placements, new THREE.Vector3(0, 0, 0)).map((placement) => placement.node.name);
    expect(names).toEqual(["near.png", "middle.png", "far.png"]);
  });

  it("stops at the cap, keeping the nearest", () => {
    const placements = Array.from({ length: THUMBNAIL_LIMIT + 10 }, (_, index) => placementAt(file(`${index}.png`, 10), index));
    const chosen = thumbnailCandidates(placements, new THREE.Vector3(-1, 0, 0));
    expect(chosen).toHaveLength(THUMBNAIL_LIMIT);
    expect(chosen[chosen.length - 1].node.name).toBe(`${THUMBNAIL_LIMIT - 1}.png`);
  });
});

describe("fitToRoof", () => {
  it("keeps a landscape picture's proportions inside a square roof", () => {
    const { width, depth } = fitToRoof(160, 90, 1, 1);
    expect(width / depth).toBeCloseTo(160 / 90);
    expect(width).toBeLessThan(1);
  });

  it("keeps a portrait picture's proportions and never overhangs the roof", () => {
    const { width, depth } = fitToRoof(90, 160, 2, 1);
    expect(width / depth).toBeCloseTo(90 / 160);
    expect(depth).toBeLessThan(1);
    expect(width).toBeLessThan(2);
  });
});

describe("ThumbnailLoader", () => {
  /** A read that never settles until told to, so what is in flight can be counted. */
  function pendingReads() {
    const calls: { node: FsNode; signal: AbortSignal }[] = [];
    const read = (node: FsNode, signal: AbortSignal) => {
      calls.push({ node, signal });
      return new Promise<Blob>(() => {});
    };
    return { calls, read };
  }

  it("reads only a couple of files at a time, nearest first", () => {
    const { calls, read } = pendingReads();
    const loader = new ThumbnailLoader(read, 1);
    const placements = [placementAt(file("far.png"), 30), placementAt(file("near.png"), 3), placementAt(file("mid.png"), 10)];
    loader.request("area", new THREE.Group(), placements, new THREE.Vector3());
    expect(calls).toHaveLength(THUMBNAIL_CONCURRENCY);
    expect(calls.map((call) => call.node.name)).toEqual(["near.png", "mid.png"]);
  });

  it("abandons what it was reading when the view moves on", () => {
    const { calls, read } = pendingReads();
    const loader = new ThumbnailLoader(read, 1);
    loader.request("area", new THREE.Group(), [placementAt(file("a.png"), 1)], new THREE.Vector3());
    loader.cancel();
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("does nothing without a way to read files", () => {
    const loader = new ThumbnailLoader(undefined, 1);
    expect(() => loader.request("area", new THREE.Group(), [placementAt(file("a.png"), 1)], new THREE.Vector3())).not.toThrow();
  });
});
