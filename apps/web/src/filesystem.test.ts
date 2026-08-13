import { describe, expect, it } from "vitest";
import { rootFromFileList } from "./filesystem";

describe("browser filesystem adapter", () => {
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
    expect(snapshot?.root.children?.[1].children?.[0].resource?.readable).toBe(true);
    expect(snapshot?.sourceLabel).toContain("LOCAL SNAPSHOT");
  });
});
