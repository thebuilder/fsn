import { describe, expect, it } from "vitest";
import type { FsNode } from "./filesystem";
import { combineUsage, formatUsage, formatUsageBytes, measureTree, usageOfLoadedTree, type MeasuredEntry } from "./usage";

function directory(name: string, children?: FsNode[]): FsNode {
  return { id: name, parentId: null, name, kind: "directory", children };
}

function file(name: string, size: number, modified?: number): FsNode {
  return { id: name, parentId: null, name, kind: "file", size, modified };
}

/** Lists a node tree the way an adapter would list a disk, but out of memory. */
function listNodes(node: FsNode): Promise<MeasuredEntry<FsNode>[]> {
  if (!node.children) return Promise.reject(new Error("unreadable"));
  return Promise.resolve(node.children.map((child) => child.kind === "directory"
    ? { kind: "directory" as const, directory: child }
    : { kind: "file" as const, size: child.size, modified: child.modified }));
}

function tree(): FsNode {
  return directory("root", [
    file("a.bin", 100, 10),
    directory("src", [file("b.bin", 20, 30), directory("deep", [file("c.bin", 3, 20)])]),
    directory("empty", []),
  ]);
}

describe("measureTree", () => {
  it("totals every file beneath the root, however deep", async () => {
    const usage = await measureTree(tree(), listNodes, { concurrency: 2, entryLimit: 1000 });
    expect(usage).toEqual({ bytes: 123, files: 3, directories: 3, newest: 30, complete: true });
  });

  it("reports a lower bound when a directory cannot be listed", async () => {
    const root = directory("root", [file("a.bin", 5), directory("locked")]);
    const usage = await measureTree(root, listNodes, { concurrency: 4, entryLimit: 1000 });
    expect(usage.bytes).toBe(5);
    expect(usage.complete).toBe(false);
  });

  it("stops at the entry limit and says it did", async () => {
    const usage = await measureTree(tree(), listNodes, { concurrency: 1, entryLimit: 2 });
    expect(usage.complete).toBe(false);
    expect(usage.files + usage.directories).toBeLessThanOrEqual(2);
  });

  it("reports running totals as directories land", async () => {
    const seen: number[] = [];
    await measureTree(tree(), listNodes, { concurrency: 1, entryLimit: 1000, onProgress: (usage) => seen.push(usage.files) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(3);
  });

  it("rejects once cancelled instead of finishing the walk", async () => {
    const controller = new AbortController();
    const slowList = (node: FsNode) => {
      controller.abort();
      return listNodes(node);
    };
    await expect(measureTree(tree(), slowList, { concurrency: 1, entryLimit: 1000, signal: controller.signal })).rejects.toBeDefined();
  });
});

describe("usageOfLoadedTree", () => {
  it("counts an in-memory tree without any listing", () => {
    expect(usageOfLoadedTree(tree())).toEqual({ bytes: 123, files: 3, directories: 3, newest: 30, complete: true });
  });

  it("treats a directory that was never read as unknown rather than empty", () => {
    const usage = usageOfLoadedTree(directory("root", [file("a", 1), directory("unread")]));
    expect(usage.complete).toBe(false);
  });
});

describe("combineUsage", () => {
  it("adds a directory's own files to its measured subdirectories", () => {
    const measured = directory("src");
    measured.usage = { bytes: 50, files: 2, directories: 1, newest: 99, complete: true };
    const usage = combineUsage([file("a", 10, 5), measured]);
    expect(usage).toEqual({ bytes: 60, files: 3, directories: 2, newest: 99, complete: true });
  });

  it("is a lower bound while any subdirectory is still unmeasured", () => {
    expect(combineUsage([file("a", 10), directory("pending")]).complete).toBe(false);
  });
});

describe("formatUsage", () => {
  it("marks a partial total as a lower bound", () => {
    expect(formatUsageBytes({ bytes: 2048, files: 1, directories: 0, complete: true })).toBe("2.0 KB");
    expect(formatUsageBytes({ bytes: 2048, files: 1, directories: 0, complete: false })).toBe("≥ 2.0 KB");
  });

  it("says how many files the size is spread across", () => {
    expect(formatUsage({ bytes: 5 * 1024 ** 3, files: 12408, directories: 9, complete: true })).toBe("5.0 GB · 12,408 files");
    expect(formatUsage({ bytes: 1, files: 1, directories: 0, complete: true })).toBe("1 B · 1 file");
  });
});
