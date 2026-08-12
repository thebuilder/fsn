import { describe, expect, it } from "vitest";
import type { FsNode } from "@fsn/core";
import { rendererFor } from "./registry";

function readableFile(name: string): FsNode {
  return {
    id: name,
    parentId: null,
    name,
    kind: "file",
    size: 1,
    resource: { id: name, readable: true },
  };
}

describe("viewer registry", () => {
  it.each(["README.md", "component.mdx", "workflow.yml", "compose.yaml", "Cargo.toml", ".env.local"])(
    "routes %s to the text viewer",
    (name) => {
      expect(rendererFor(readableFile(name)).id).toBe("text");
    },
  );

  it.each(["data.json", "map.geojson", "trace.har", "notebook.ipynb", "schema.avsc", "site.webmanifest"])(
    "routes structured JSON format %s to the JSON viewer",
    (name) => {
      expect(rendererFor(readableFile(name)).id).toBe("json");
    },
  );

  it.each(["archive.zip", "document.docx", "database.sqlite", "module.wasm", "payload.pb", "process.lock", "registry.reg", "settings.plist", "source.map"])(
    "does not treat binary or ambiguous format %s as text",
    (name) => {
      expect(rendererFor(readableFile(name)).id).not.toBe("text");
    },
  );
});
