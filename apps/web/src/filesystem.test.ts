import { describe, expect, it } from "vitest";
import { rootFromDirectoryHandle, rootFromFileList } from "./filesystem";

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

type FakeFileEntry = {
  kind: "file";
  name: string;
  getFile: () => Promise<unknown>;
};

type FakeDirEntry = {
  kind: "directory";
  name: string;
  entries: () => AsyncGenerator<[string, FakeFileEntry | FakeDirEntry]>;
};

function fakeFile(name: string, getFile: () => Promise<unknown>): FakeFileEntry {
  return { kind: "file", name, getFile };
}

/** Builds a fake `FileSystemDirectoryHandle`, optionally gating and counting calls to `entries()`. */
function fakeDirectory(
  name: string,
  childEntries: [string, FakeFileEntry | FakeDirEntry][],
  options: { gate?: Promise<void>; onEntries?: () => void } = {},
): FakeDirEntry {
  return {
    kind: "directory",
    name,
    entries: async function* (): AsyncGenerator<[string, FakeFileEntry | FakeDirEntry]> {
      options.onEntries?.();
      if (options.gate) await options.gate;
      for (const entry of childEntries) yield entry;
    },
  };
}

describe("browser filesystem adapter: metadata pool", () => {
  it("batches metadata for every file through the pool, regardless of completion order", async () => {
    const fileCount = 40;
    const entries: [string, FakeFileEntry][] = Array.from({ length: fileCount }, (_, index) => {
      const name = `file-${String(index).padStart(2, "0")}.txt`;
      return [
        name,
        fakeFile(
          name,
          () =>
            new Promise((resolve) => {
              // Reverse the completion order so the fastest-queued handle is not the first slotted.
              setTimeout(() => resolve({ size: index + 1, lastModified: index }), (fileCount - index) % 7);
            }),
        ),
      ];
    });
    const dir = fakeDirectory("pool-root", entries);

    const snapshot = await rootFromDirectoryHandle(dir as unknown as FileSystemDirectoryHandle);
    const children = snapshot.root.children ?? [];

    expect(children).toHaveLength(fileCount);
    for (const child of children) {
      expect(child.size).toBeGreaterThan(0);
      expect(child.modified).toBeDefined();
    }
  });

  it("tolerates one entry's metadata failing without losing the others", async () => {
    const entries: [string, FakeFileEntry][] = [
      ["a.txt", fakeFile("a.txt", () => Promise.resolve({ size: 1, lastModified: 1 }))],
      ["b.txt", fakeFile("b.txt", () => Promise.reject(new Error("permission denied")))],
      ["c.txt", fakeFile("c.txt", () => Promise.resolve({ size: 3, lastModified: 3 }))],
    ];
    const dir = fakeDirectory("failure-root", entries);

    const snapshot = await rootFromDirectoryHandle(dir as unknown as FileSystemDirectoryHandle);
    const children = snapshot.root.children ?? [];

    expect(children.map((node) => node.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    const failed = children.find((node) => node.name === "b.txt");
    expect(failed?.size).toBeUndefined();
    expect(children.find((node) => node.name === "a.txt")?.size).toBe(1);
    expect(children.find((node) => node.name === "c.txt")?.size).toBe(3);
  });
});
