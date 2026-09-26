import { describe, expect, it } from "vitest";
import { GLOW_STORAGE_KEY, glowByDefault, readGlowPreference, writeGlowPreference } from "./bloom";

describe("glowByDefault", () => {
  it("offers the glow to an ordinary desktop screen", () => {
    expect(glowByDefault({ coarsePointer: false, width: 1440, height: 900, pixelRatio: 1 })).toBe(true);
    expect(glowByDefault({ coarsePointer: false, width: 1280, height: 800, pixelRatio: 2 })).toBe(true);
  });

  it("holds it back from a touch device, whatever its size", () => {
    expect(glowByDefault({ coarsePointer: true, width: 390, height: 844, pixelRatio: 1 })).toBe(false);
    expect(glowByDefault({ coarsePointer: true, width: 1366, height: 1024, pixelRatio: 1 })).toBe(false);
  });

  it("holds it back from a buffer so large every pass would be costly", () => {
    expect(glowByDefault({ coarsePointer: false, width: 1728, height: 1117, pixelRatio: 2 })).toBe(false);
    expect(glowByDefault({ coarsePointer: false, width: 3840, height: 2160, pixelRatio: 1 })).toBe(false);
  });
});

describe("glow preference", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  }

  it("has no opinion until the viewer has made a choice", () => {
    expect(readGlowPreference(memoryStorage())).toBeNull();
    expect(readGlowPreference(null)).toBeNull();
  });

  it("remembers a choice either way", () => {
    const storage = memoryStorage();
    writeGlowPreference(storage, false);
    expect(readGlowPreference(storage)).toBe(false);
    writeGlowPreference(storage, true);
    expect(readGlowPreference(storage)).toBe(true);
  });

  it("ignores a value it did not write", () => {
    const storage = memoryStorage();
    storage.setItem(GLOW_STORAGE_KEY, "maybe");
    expect(readGlowPreference(storage)).toBeNull();
  });

  it("survives storage that refuses to be used", () => {
    const refusing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readGlowPreference(refusing)).toBeNull();
    expect(() => writeGlowPreference(refusing, true)).not.toThrow();
  });
});
