import { describe, expect, it } from "vitest";
import { categoryOf, formatBytes, rootFromFileList } from "./filesystem";

describe("filesystem utilities", () => {
  it("classifies representative file types", () => {
    expect(categoryOf({ id: "1", parentId: null, kind: "file", name: "scene.ts" })).toBe("code");
    expect(categoryOf({ id: "2", parentId: null, kind: "file", name: "photo.png" })).toBe("image");
    expect(categoryOf({ id: "3", parentId: null, kind: "directory", name: "src" })).toBe("directory");
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
