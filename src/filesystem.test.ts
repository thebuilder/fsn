import { describe, expect, it } from "vitest";
import { canReadAsText, categoryOf, formatBytes, rootFromFileList, searchFilesystem, type FsNode } from "./filesystem";

function directory(name: string, children: FsNode[]): FsNode {
  return { id: name, parentId: null, name, kind: "directory", children };
}

function file(name: string): FsNode {
  return { id: name, parentId: null, name, kind: "file", size: 1 };
}

function fixtureTree(): FsNode {
  return directory("root", [
    directory("src", [file("scene.ts"), file("main.ts"), directory("deep", [file("main-worker.ts")])]),
    { id: "unopened", parentId: "root", name: "unopened", kind: "directory" },
    file("readme.md"),
  ]);
}

describe("filesystem utilities", () => {
  it("classifies representative file types", () => {
    expect(categoryOf(file("scene.ts"))).toBe("code");
    expect(categoryOf(file("photo.png"))).toBe("image");
    expect(categoryOf(directory("src", []))).toBe("directory");
    expect(categoryOf(file("turbine.stl"))).toBe("model");
    expect(categoryOf(file("Inter.woff2"))).toBe("font");
    expect(categoryOf(file("release.zip"))).toBe("archive");
  });

  it("classifies files that carry their type in the name", () => {
    expect(categoryOf(file("Makefile"))).toBe("code");
    expect(categoryOf(file(".gitignore"))).toBe("code");
    expect(categoryOf(file("LICENSE"))).toBe("document");
    expect(categoryOf(file(".env.local"))).toBe("code");
    expect(categoryOf(file("Finder"))).toBe("unknown");
  });

  it("only reads formats it can actually decode as text", () => {
    expect(canReadAsText(file("notes.md"))).toBe(true);
    expect(canReadAsText(file("Dockerfile"))).toBe(true);
    expect(canReadAsText(file("archive.zip"))).toBe(false);
    expect(canReadAsText(file("mystery.dat"))).toBe(false);
    expect(canReadAsText(directory("src", []))).toBe(false);
  });

  it("formats byte sizes for the interface", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("returns no snapshot for an empty selection", () => {
    expect(rootFromFileList({ length: 0 } as FileList)).toBeNull();
  });

  it("reconstructs a selected directory hierarchy from relative paths", () => {
    const files = [
      { name: "readme.txt", webkitRelativePath: "fixture/notes/readme.txt", size: 120, lastModified: 10 },
      { name: "photo.png", webkitRelativePath: "fixture/images/photo.png", size: 640, lastModified: 20 },
    ] as unknown as FileList;

    const snapshot = rootFromFileList(files);

    expect(snapshot?.root.name).toBe("fixture");
    expect(snapshot?.root.children?.map((node) => node.name)).toEqual(["images", "notes"]);
    expect(snapshot?.root.children?.[1].children?.[0].name).toBe("readme.txt");
    expect(snapshot?.sourceLabel).toContain("LOCAL SNAPSHOT");
  });
});

describe("filesystem search", () => {
  it("stays inside the current directory when not recursive", () => {
    const root = fixtureTree();

    const outcome = searchFilesystem([root], "main", { recursive: false, limit: 10 });

    expect(outcome.matches).toEqual([]);
    expect(outcome.total).toBe(0);
  });

  it("walks the whole loaded tree when recursive and reports each match's trail", () => {
    const root = fixtureTree();

    const outcome = searchFilesystem([root], "main", { recursive: true, limit: 10 });

    expect(outcome.matches.map((match) => match.node.name)).toEqual(["main.ts", "main-worker.ts"]);
    expect(outcome.matches[1].trail.map((part) => part.name)).toEqual(["root", "src", "deep"]);
    expect(outcome.total).toBe(2);
  });

  it("ranks prefix matches above matches buried inside a name", () => {
    const root = directory("root", [file("zz-main.ts"), file("main.ts")]);

    const outcome = searchFilesystem([root], "main", { recursive: false, limit: 10 });

    expect(outcome.matches.map((match) => match.node.name)).toEqual(["main.ts", "zz-main.ts"]);
  });

  it("caps returned matches while still counting every match", () => {
    const root = directory("root", Array.from({ length: 40 }, (_, index) => file(`log-${index}.txt`)));

    const outcome = searchFilesystem([root], "log", { recursive: false, limit: 25 });

    expect(outcome.matches).toHaveLength(25);
    expect(outcome.total).toBe(40);
  });

  it("counts directories that have not been read instead of reaching for disk", () => {
    const root = fixtureTree();

    const outcome = searchFilesystem([root], "ts", { recursive: true, limit: 10 });

    expect(outcome.unreadDirectories).toBe(1);
    expect(outcome.complete).toBe(true);
  });
});
