import { describe, expect, it } from "vitest";
import { createGitStatusIndex, type FsNode } from "@fsn/core";
import {
  AGE_COLORS,
  AGE_UNKNOWN_COLOR,
  DEFAULT_LENS,
  GIT_COLORS,
  ageColor,
  createAgeLens,
  createGitLens,
  legendFor,
  markerChild,
  readLensChoice,
  writeLensChoice,
} from "./lens";

const now = Date.UTC(2026, 8, 26, 12);
const day = 86_400_000;

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [["fsn.lens", initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("lens choice persistence", () => {
  it("round-trips a choice through storage", () => {
    const storage = memoryStorage();
    writeLensChoice(storage, { size: "total", colour: "age" });
    expect(readLensChoice(storage)).toEqual({ size: "total", colour: "age" });
  });

  it("falls back to the default for missing, malformed or foreign values", () => {
    expect(readLensChoice(memoryStorage())).toEqual(DEFAULT_LENS);
    expect(readLensChoice(memoryStorage("{not json"))).toEqual(DEFAULT_LENS);
    expect(readLensChoice(memoryStorage(JSON.stringify({ size: "huge", colour: "rainbow" })))).toEqual(DEFAULT_LENS);
    expect(readLensChoice(null)).toEqual(DEFAULT_LENS);
  });

  it("survives storage that refuses to be touched", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLensChoice(hostile)).toEqual(DEFAULT_LENS);
    expect(() => writeLensChoice(hostile, DEFAULT_LENS)).not.toThrow();
  });
});

describe("age colours", () => {
  it("runs hot for today and cold for years ago", () => {
    expect(ageColor(now - 60_000, now)).toBe(AGE_COLORS[0]);
    expect(ageColor(now - 10 * 365 * day, now)).toBe(AGE_COLORS[AGE_COLORS.length - 1]);
  });

  it("paints an object with no timestamp as unknown rather than as old", () => {
    expect(ageColor(undefined, now)).toBe(AGE_UNKNOWN_COLOR);
  });

  it("has a legend row for every colour it can paint", () => {
    const rows = legendFor("age").rows;
    expect(rows).toHaveLength(AGE_COLORS.length + 1);
    expect(rows[rows.length - 1]).toEqual({ label: "Unknown", color: AGE_UNKNOWN_COLOR });
  });

  it("colours a folder by the newest change measured beneath it", () => {
    const folder: FsNode = { id: "f", parentId: null, name: "f", kind: "directory", modified: now - 900 * day };
    const lens = createAgeLens(now);
    expect(lens.colorFor(folder)).toBe(AGE_COLORS[4]);
    folder.usage = { bytes: 1, files: 1, directories: 0, newest: now - 1000, complete: true };
    expect(lens.colorFor(folder)).toBe(AGE_COLORS[0]);
  });
});

describe("markerChild", () => {
  it("names the child a marker stands for from the peek", () => {
    const folder: FsNode = {
      id: "f",
      parentId: null,
      name: "f",
      kind: "directory",
      peek: { total: 2, categories: ["directory", "code"], names: ["lib", "main.ts"], modified: [undefined, now] },
    };
    expect(markerChild(folder, 0)).toEqual({ name: "lib", modified: undefined, kind: "directory" });
    expect(markerChild(folder, 1)).toEqual({ name: "main.ts", modified: now, kind: "file" });
  });

  it("finds a time the peek could not afford among children read since", () => {
    const folder: FsNode = {
      id: "f",
      parentId: null,
      name: "f",
      kind: "directory",
      peek: { total: 1, categories: ["code"], names: ["main.ts"] },
      children: [{ id: "m", parentId: "f", name: "main.ts", kind: "file", modified: now - day }],
    };
    expect(markerChild(folder, 0).modified).toBe(now - day);
  });
});

describe("git lens", () => {
  const status = createGitStatusIndex({
    truncated: false,
    entries: [
      { path: "src/scene.ts", state: "modified" },
      { path: "notes", state: "untracked" },
    ],
  });
  const paths = new Map<string, string[]>([["src", ["src"]], ["scene", ["src", "scene.ts"]], ["root", []]]);
  const lens = createGitLens(status, (node) => paths.get(node.id) ?? null);

  it("colours a file by its own status and a folder by the strongest beneath it", () => {
    expect(lens.colorFor({ id: "scene", parentId: "src", name: "scene.ts", kind: "file" })).toBe(GIT_COLORS.modified);
    expect(lens.colorFor({ id: "src", parentId: "root", name: "src", kind: "directory" })).toBe(GIT_COLORS.modified);
  });

  it("colours a marker by the child it stands for", () => {
    const root: FsNode = {
      id: "root",
      parentId: null,
      name: "repo",
      kind: "directory",
      peek: { total: 3, categories: ["directory", "directory", "document"], names: ["src", "notes", "README.md"] },
    };
    expect(lens.markerColorFor(root, 0)).toBe(GIT_COLORS.modified);
    expect(lens.markerColorFor(root, 1)).toBe(GIT_COLORS.untracked);
    expect(lens.markerColorFor(root, 2)).toBe(GIT_COLORS.clean);
  });

  it("stays quiet about a node it cannot place", () => {
    expect(lens.colorFor({ id: "stray", parentId: null, name: "stray", kind: "file" })).toBeNull();
  });
});
