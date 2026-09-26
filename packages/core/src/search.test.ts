import { describe, expect, it } from "vitest";
import type { FsNode } from "./filesystem";
import { indexChildren, locationOf, searchIndex, type IndexedObject } from "./search";

function directory(name: string, children: FsNode[] = []): FsNode {
  return { id: name, parentId: null, name, kind: "directory", children };
}

function file(name: string, id = name): FsNode {
  return { id, parentId: null, name, kind: "file", size: 1 };
}

/** Indexes a whole in-memory tree the way the navigator's walk does, one directory at a time. */
function indexTree(root: FsNode): IndexedObject[] {
  const entries: IndexedObject[] = [];
  const queue: FsNode[][] = [[root]];
  for (let head = 0; head < queue.length; head += 1) {
    const trail = queue[head];
    const children = trail[trail.length - 1].children ?? [];
    entries.push(...indexChildren(trail, children));
    for (const child of children) if (child.kind === "directory") queue.push([...trail, child]);
  }
  return entries;
}

function names(entries: IndexedObject[]): string[] {
  return entries.map((entry) => entry.path);
}

describe("indexChildren", () => {
  it("records each object's path below the root, without the root's own name", () => {
    const src = directory("src", [file("scene.ts")]);
    const root = directory("Macintosh HD", [directory("Projects", [src]), file("readme.md")]);

    const entries = indexTree(root);

    expect(names(entries)).toEqual(["Projects", "readme.md", "Projects/src", "Projects/src/scene.ts"]);
    expect(entries.map(locationOf)).toEqual(["/", "/", "/Projects", "/Projects/src"]);
  });

  it("keeps separators and escapes inside a name literal rather than inventing a level", () => {
    const root = directory("disk", [directory("a%2Fb", [file("#1 ?.txt")])]);

    const entries = indexTree(root);

    expect(entries[1].path).toBe("a%2Fb/#1 ?.txt");
    expect(locationOf(entries[1])).toBe("/a%2Fb");
  });
});

describe("searchIndex", () => {
  it("finds objects anywhere in the tree, not only where you are standing", () => {
    const deep = directory("deep", [file("main-worker.ts")]);
    const root = directory("root", [directory("src", [file("main.ts"), deep]), file("readme.md")]);

    const outcome = searchIndex(indexTree(root), "main", { limit: 10, here: "root" });

    expect(names(outcome.matches)).toEqual(["src/main.ts", "src/deep/main-worker.ts"]);
    expect(outcome.total).toBe(2);
  });

  it("puts what is in the current directory ahead of a better match elsewhere", () => {
    const root = directory("root", [
      directory("Logs", [file("log-001.txt")]),
      directory("Docs", [file("changelog.md")]),
    ]);

    const outcome = searchIndex(indexTree(root), "log", { limit: 10, here: "Docs" });

    // Standing in Docs, its own buried match leads; then the prefix matches elsewhere.
    expect(names(outcome.matches)).toEqual(["Docs/changelog.md", "Logs", "Logs/log-001.txt"]);
  });

  it("ranks a whole-prefix match above a word start, and a word start above a buried match", () => {
    const root = directory("root", [file("zzmain.ts"), file("old-main.ts"), file("main.ts")]);

    const outcome = searchIndex(indexTree(root), "main", { limit: 10 });

    expect(names(outcome.matches)).toEqual(["main.ts", "old-main.ts", "zzmain.ts"]);
  });

  it("finds a word start even when the first occurrence is buried", () => {
    const root = directory("root", [file("domain-main.ts"), file("xmainx.ts")]);

    const outcome = searchIndex(indexTree(root), "main", { limit: 10 });

    expect(names(outcome.matches)).toEqual(["domain-main.ts", "xmainx.ts"]);
  });

  it("prefers what is below you to an equal match elsewhere, then the shallower one", () => {
    const root = directory("root", [
      directory("away", [directory("far", [file("report.md", "away-far-report")]), file("report.md", "away-report")]),
      directory("here", [directory("inner", [file("report.md", "here-report")])]),
    ]);

    const outcome = searchIndex(indexTree(root), "report", { limit: 10, here: "here" });

    expect(names(outcome.matches)).toEqual(["here/inner/report.md", "away/report.md", "away/far/report.md"]);
  });

  it("lists directories ahead of files when everything else is tied, then orders names naturally", () => {
    const root = directory("root", [file("item-10"), file("item-9"), directory("item-dir")]);

    const outcome = searchIndex(indexTree(root), "item", { limit: 10 });

    expect(names(outcome.matches)).toEqual(["item-dir", "item-9", "item-10"]);
  });

  it("matches the path instead of the name once the query has a separator in it", () => {
    const root = directory("root", [
      directory("fsn-revival", [directory("src", [file("scene.ts")])]),
      directory("site", [directory("src", [file("index.html")])]),
    ]);

    const outcome = searchIndex(indexTree(root), "revival/src", { limit: 10 });

    expect(names(outcome.matches)).toEqual(["fsn-revival/src", "fsn-revival/src/scene.ts"]);
  });

  it("anchors a leading separator to the root", () => {
    const root = directory("root", [directory("src"), directory("lib", [directory("src")])]);

    const outcome = searchIndex(indexTree(root), "/src", { limit: 10 });

    expect(names(outcome.matches)).toEqual(["src", "lib/src"]);
  });

  it("ignores case and the composed-versus-decomposed spelling of accents", () => {
    const decomposed = "Café Notes.md";
    const root = directory("root", [file(decomposed)]);

    const outcome = searchIndex(indexTree(root), "CAFÉ", { limit: 10 });

    expect(outcome.matches.map((entry) => entry.node.name)).toEqual([decomposed]);
  });

  it("keeps only the best matches while still counting every one", () => {
    const children = Array.from({ length: 400 }, (_, index) => file(`log-${index}.txt`));
    const root = directory("root", children.reverse());

    const outcome = searchIndex(indexTree(root), "log", { limit: 25 });

    expect(outcome.matches).toHaveLength(25);
    expect(outcome.total).toBe(400);
    expect(outcome.matches.slice(0, 3).map((entry) => entry.node.name)).toEqual(["log-0.txt", "log-1.txt", "log-2.txt"]);
  });

  it("returns nothing for a blank query rather than the whole tree", () => {
    const root = directory("root", [file("a.txt")]);

    expect(searchIndex(indexTree(root), "   ", { limit: 10 })).toEqual({ matches: [], total: 0 });
  });

  it("stays quick across a tree the size of the index cap", () => {
    const children = Array.from({ length: 50_000 }, (_, index) => file(`f-${index}.txt`));
    const entries = indexTree(directory("root", children));

    const start = performance.now();
    const outcome = searchIndex(entries, "f", { limit: 25 });
    const elapsed = performance.now() - start;

    expect(outcome.total).toBe(50_000);
    expect(elapsed).toBeLessThan(1000);
  });
});
