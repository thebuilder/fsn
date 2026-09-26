import type { FsNode } from "@fsn/core";
import { describe, expect, it } from "vitest";
import { TreeIndex, type TreeIndexOptions } from "./tree-index";

function directory(name: string, children?: FsNode[]): FsNode {
  return { id: name, parentId: null, name, kind: "directory", children };
}

function file(name: string): FsNode {
  return { id: name, parentId: null, name, kind: "file", size: 1 };
}

/** The in-memory adapter's contract: a directory's children, already on the node. */
async function readInMemory(node: FsNode): Promise<FsNode[]> {
  return node.children ?? [];
}

function build(root: FsNode, options: Partial<TreeIndexOptions> = {}): TreeIndex {
  return new TreeIndex(root, {
    read: readInMemory,
    signal: new AbortController().signal,
    limit: 10_000,
    concurrency: 4,
    ...options,
  });
}

function wideTree(width: number, depth: number, prefix = "d"): FsNode {
  if (depth === 0) return file(`${prefix}.txt`);
  return directory(prefix, Array.from({ length: width }, (_, index) => wideTree(width, depth - 1, `${prefix}${index}`)));
}

describe("TreeIndex", () => {
  it("gathers every object in the source, shallowest first, with its path below the root", async () => {
    const root = directory("disk", [
      directory("Projects", [directory("src", [file("scene.ts")])]),
      directory("Logs", [file("boot.log")]),
      file("readme.md"),
    ]);

    const index = build(root);
    await index.done;

    expect(index.status).toBe("complete");
    expect(index.entries.map((entry) => entry.path)).toEqual([
      "Projects", "Logs", "readme.md", "Projects/src", "Logs/boot.log", "Projects/src/scene.ts",
    ]);
  });

  it("stops growing at its cap and says so", async () => {
    const index = build(wideTree(6, 4), { limit: 100 });
    await index.done;

    expect(index.status).toBe("capped");
    expect(index.entries).toHaveLength(100);
  });

  it("keeps no more than the allowed number of reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const read = async (node: FsNode): Promise<FsNode[]> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return node.children ?? [];
    };

    const index = build(wideTree(5, 3), { read, concurrency: 3 });
    await index.done;

    expect(index.status).toBe("complete");
    expect(peak).toBe(3);
    expect(index.entries).toHaveLength(5 + 25 + 125);
  });

  it("stops at once when its source is replaced, and adds nothing afterwards", async () => {
    const controller = new AbortController();
    const index = build(wideTree(8, 4), {
      signal: controller.signal,
      sliceMs: 0,
      onProgress: () => {
        if (index.entries.length > 0 && index.status === "indexing") controller.abort();
      },
    });
    await index.done;
    const counted = index.entries.length;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(index.status).toBe("cancelled");
    expect(counted).toBeLessThan(8 + 64 + 512 + 4096);
    expect(index.entries).toHaveLength(counted);
  });

  it("hands the thread back while walking an in-memory tree, with partial results visible at each yield", async () => {
    const seen: number[] = [];
    let yields = 0;
    const index = build(wideTree(6, 4), {
      sliceMs: 0,
      yieldToPage: () => {
        yields += 1;
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
      onProgress: () => seen.push(index.entries.length),
    });
    await index.done;

    expect(yields).toBeGreaterThan(1);
    // Progress arrives while the walk is still going, and the count only ever grows.
    expect(seen.some((count) => count > 0 && count < index.entries.length)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBe(6 + 36 + 216 + 1296);
  });

  it("skips a directory it cannot list and carries on with the rest", async () => {
    const locked = directory("locked");
    const root = directory("disk", [locked, directory("open", [file("a.txt")])]);
    const read = async (node: FsNode): Promise<FsNode[]> => {
      if (node === locked) throw new Error("denied");
      return node.children ?? [];
    };

    const index = build(root, { read });
    await index.done;

    expect(index.status).toBe("complete");
    expect(index.unreadable).toBe(1);
    expect(index.entries.map((entry) => entry.path)).toEqual(["locked", "open", "open/a.txt"]);
  });

  it("finishes at once on an empty source", async () => {
    const index = build(directory("empty", []));
    await index.done;

    expect(index.status).toBe("complete");
    expect(index.entries).toEqual([]);
  });
});
