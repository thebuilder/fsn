import { describe, expect, it } from "vitest";
import { createGitStatusIndex } from "./git";

const index = createGitStatusIndex({
  truncated: false,
  entries: [
    { path: "src/scene.ts", state: "modified" },
    { path: "src/new.ts", state: "added" },
    { path: "src/lib/gone.ts", state: "deleted" },
    { path: "notes", state: "untracked" },
    { path: "build", state: "ignored" },
    { path: "docs/merge.md", state: "conflicted" },
    { path: "docs/draft.md", state: "untracked" },
  ],
});

describe("createGitStatusIndex", () => {
  it("reports a file's own state", () => {
    expect(index.stateAt(["src", "scene.ts"], "file")).toBe("modified");
    expect(index.stateAt(["src", "new.ts"], "file")).toBe("added");
  });

  it("reads anything unreported as clean", () => {
    expect(index.stateAt(["src", "main.ts"], "file")).toBe("clean");
    expect(index.stateAt(["assets"], "directory")).toBe("clean");
  });

  it("gives a folder the strongest state anywhere beneath it", () => {
    expect(index.stateAt(["docs"], "directory")).toBe("conflicted");
    expect(index.stateAt(["src"], "directory")).toBe("modified");
    expect(index.stateAt([], "directory")).toBe("conflicted");
  });

  it("shows a folder that lost a file as modified, since the file has nothing left to colour", () => {
    expect(index.stateAt(["src", "lib"], "directory")).toBe("modified");
  });

  it("carries a collapsed untracked or ignored folder's state to everything inside it", () => {
    expect(index.stateAt(["notes"], "directory")).toBe("untracked");
    expect(index.stateAt(["notes", "a", "b.md"], "file")).toBe("untracked");
    expect(index.stateAt(["build", "out.bin"], "file")).toBe("ignored");
  });

  it("does not let an ignored folder colour the folder around it", () => {
    const nested = createGitStatusIndex({ truncated: false, entries: [{ path: "app/build", state: "ignored" }] });
    expect(nested.stateAt(["app"], "directory")).toBe("clean");
    expect(nested.stateAt(["app", "build"], "directory")).toBe("ignored");
  });

  it("covers the whole folder when the backend reports the root itself", () => {
    const inside = createGitStatusIndex({ truncated: false, entries: [{ path: "", state: "untracked" }] });
    expect(inside.stateAt(["any", "file.txt"], "file")).toBe("untracked");
  });
});
