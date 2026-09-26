import { describe, expect, it } from "vitest";
import { canReadAsText, categoryOf, formatBytes, hasBytes, mediaExtensionSets, mimeTypeFor, pathFor, type FsNode } from "./filesystem";

function directory(name: string, children: FsNode[]): FsNode {
  return { id: name, parentId: null, name, kind: "directory", children };
}

function file(name: string): FsNode {
  return { id: name, parentId: null, name, kind: "file", size: 1 };
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

describe("mimeTypeFor", () => {
  it("gives every media extension a concrete MIME type, not the generic fallback", () => {
    for (const [family, extensions] of Object.entries(mediaExtensionSets)) {
      for (const extension of extensions) {
        const mime = mimeTypeFor(`x.${extension}`);
        expect(mime, `${family} extension "${extension}"`).not.toBe("application/octet-stream");
        if (family === "image") {
          // Audio/video share containers across families (e.g. `weba` is audio/webm,
          // `ogv` is video/ogg), so only image types can be asserted by prefix here.
          expect(mime, `${family} extension "${extension}"`).toMatch(/^image\//);
        }
      }
    }
  });

  it("pins the jfif regression that once desynced desktop's hand-maintained MIME map from core's classification", () => {
    expect(mimeTypeFor("photo.jfif")).toBe("image/jpeg");
  });

  it("falls back to a generic type for names with no usable extension", () => {
    expect(mimeTypeFor("Makefile")).toBe("application/octet-stream");
  });
});
