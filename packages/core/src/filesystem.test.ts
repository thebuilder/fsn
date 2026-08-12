import { describe, expect, it } from "vitest";
import { canReadAsText, categoryOf, formatBytes, hasBytes, pathFor, searchFilesystem, type FsNode } from "./filesystem";

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

  it.each([
    ["README.md", "document"],
    ["guide.mdx", "code"],
    ["workflow.yml", "code"],
    ["compose.yaml", "code"],
    ["Cargo.toml", "code"],
    ["schema.graphql", "code"],
    ["notebook.ipynb", "code"],
    ["reference.markdown", "document"],
    ["manual.rst", "document"],
  ] as const)("classifies supported text format %s as %s", (name, category) => {
    expect(categoryOf(file(name))).toBe(category);
  });

  it("classifies files that carry their type in the name", () => {
    expect(categoryOf(file("Makefile"))).toBe("code");
    expect(categoryOf(file(".gitignore"))).toBe("code");
    expect(categoryOf(file("LICENSE"))).toBe("document");
    expect(categoryOf(file(".env.local"))).toBe("code");
    expect(categoryOf(file("Finder"))).toBe("unknown");
  });

  it("only reads formats it can actually decode as text", () => {
    for (const name of [
      "notes.md", "component.mdx", "workflow.yml", "compose.yaml", "Dockerfile", ".env.local", "Cargo.lock", "schema.avsc", "requests.http", "manual.adoc",
    ]) {
      expect(canReadAsText(file(name)), name).toBe(true);
    }

    for (const name of ["archive.zip", "document.docx", "database.sqlite", "module.wasm", "payload.pb", "process.lock", "registry.reg", "settings.plist", "source.map", "mystery.dat"]) {
      expect(canReadAsText(file(name)), name).toBe(false);
    }

    expect(canReadAsText(directory("src", []))).toBe(false);
  });

  it("formats byte sizes for the interface", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("reports byte readability without knowing the adapter resource type", () => {
    expect(hasBytes({ ...file("notes.md"), resource: { id: "opaque:1", readable: true } })).toBe(true);
    expect(hasBytes({ ...file("notes.md"), resource: { id: "opaque:2", readable: false } })).toBe(false);
    expect(hasBytes(file("notes.md"))).toBe(false);
  });

  it("builds a path from the owning ancestry", () => {
    const root = directory("root", []);
    const nested = { ...directory("src", []), id: "src", parentId: root.id };
    const entry = { ...file("main.ts"), parentId: nested.id };

    expect(pathFor(entry, [root, nested])).toBe("/root/src/main.ts");
  });
});

describe("filesystem search", () => {
  it("reaches nested directories and reports each match's trail", () => {
    const root = fixtureTree();

    const outcome = searchFilesystem([root], "main", { limit: 10 });

    expect(outcome.matches.map((match) => match.node.name)).toEqual(["main.ts", "main-worker.ts"]);
    expect(outcome.matches[1].trail.map((part) => part.name)).toEqual(["root", "src", "deep"]);
    expect(outcome.total).toBe(2);
  });

  it("searches only the subtree under the given directory", () => {
    const root = fixtureTree();
    const src = root.children?.[0] as FsNode;

    const outcome = searchFilesystem([root, src], "e", { limit: 10 });

    // "readme.md" sits above src, so it stays out of a search started inside it.
    expect(outcome.matches.map((match) => match.node.name)).toEqual(["deep", "scene.ts", "main-worker.ts"]);
  });

  it("ranks prefix matches above matches buried inside a name", () => {
    const root = directory("root", [file("zz-main.ts"), file("main.ts")]);

    const outcome = searchFilesystem([root], "main", { limit: 10 });

    expect(outcome.matches.map((match) => match.node.name)).toEqual(["main.ts", "zz-main.ts"]);
  });

  it("prefers shallow matches when ranking is otherwise tied", () => {
    const root = directory("root", [directory("nested", [file("report.md")]), file("report.md")]);

    const outcome = searchFilesystem([root], "report", { limit: 10 });

    expect(outcome.matches.map((match) => match.trail.length)).toEqual([1, 2]);
  });

  it("caps returned matches while still counting every match", () => {
    const root = directory("root", Array.from({ length: 40 }, (_, index) => file(`log-${index}.txt`)));

    const outcome = searchFilesystem([root], "log", { limit: 25 });

    expect(outcome.matches).toHaveLength(25);
    expect(outcome.total).toBe(40);
  });

  it("counts directories that have not been read instead of reaching for disk", () => {
    const root = fixtureTree();

    const outcome = searchFilesystem([root], "ts", { limit: 10 });

    expect(outcome.unreadDirectories).toBe(1);
    expect(outcome.complete).toBe(true);
  });
});
