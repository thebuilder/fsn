import { describe, expect, it } from "vitest";
import { RELOAD_GUARD_MS, recoverFromStaleBuilds, shouldReload } from "./stale-build";

function fakeWindow(storage: Map<string, string> | null) {
  const listeners = new Map<string, () => void>();
  let reloads = 0;
  const target = {
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    sessionStorage: {
      getItem: (key: string) => {
        if (!storage) throw new Error("storage blocked");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (!storage) throw new Error("storage blocked");
        storage.set(key, value);
      },
    },
    location: { reload: () => (reloads += 1) },
  };
  recoverFromStaleBuilds(target as unknown as Window);
  return {
    failImport: () => listeners.get("vite:preloadError")?.(),
    reloads: () => reloads,
  };
}

describe("stale build recovery", () => {
  it("reloads when there has been no recent reload", () => {
    expect(shouldReload(1_000_000, null)).toBe(true);
    expect(shouldReload(1_000_000, 1_000_000 - RELOAD_GUARD_MS - 1)).toBe(true);
  });

  it("holds off inside the guard window, so a broken chunk cannot loop the page", () => {
    expect(shouldReload(1_000_000, 1_000_000 - 5_000)).toBe(false);
  });

  it("reloads once for a failed import, then leaves a second failure on screen", () => {
    const page = fakeWindow(new Map());
    page.failImport();
    page.failImport();
    expect(page.reloads()).toBe(1);
  });

  it("does not reload at all when session storage is unavailable", () => {
    const page = fakeWindow(null);
    page.failImport();
    expect(page.reloads()).toBe(0);
  });
});
