import { describe, expect, it } from "vitest";
import type { FsNode, FsResource } from "@fsn/core";
import { createDemoFilesystem, type DemoResourceFactory } from "./demo";

function collectResourceIds(node: FsNode): string[] {
  return [
    ...(node.resource ? [node.resource.id] : []),
    ...(node.children ?? []).flatMap(collectResourceIds),
  ];
}

describe("demo filesystem", () => {
  it("gives replacement demo instances distinct resource IDs", () => {
    const resource = (id: string): FsResource => ({ id, readable: true });
    const resources: DemoResourceFactory = {
      text: (id) => resource(id),
      url: (id) => resource(id),
    };

    const first = new Set(collectResourceIds(createDemoFilesystem(resources).root));
    const second = collectResourceIds(createDemoFilesystem(resources).root);

    expect(first.size).toBeGreaterThan(0);
    expect(second.every((id) => !first.has(id))).toBe(true);
  });
});
