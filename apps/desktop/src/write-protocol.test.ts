import { describe, expect, it } from "vitest";
import type { DesktopFileSnapshot } from "./filesystem";
import { createWriteProtocol } from "./write-protocol";

function fakeSnapshot(sha256: string): DesktopFileSnapshot {
  return { size: 1, modified: 1, identity: "id", sha256, securityMetadata: "meta" };
}

describe("write protocol", () => {
  it("returns the recorded snapshot for a non-forced save after a read", () => {
    const protocol = createWriteProtocol();
    const snapshot = fakeSnapshot("read");

    protocol.recordRead("a", snapshot);

    expect(protocol.expectedFor("a", false)).toBe(snapshot);
  });

  it("throws when saving without a prior read", () => {
    const protocol = createWriteProtocol();

    expect(() => protocol.expectedFor("a", false)).toThrow(/Reopen this file before saving/);
  });

  it("uses the recorded conflict snapshot for a forced retry, and throws without one", () => {
    const protocol = createWriteProtocol();
    const conflict = fakeSnapshot("conflict");

    expect(() => protocol.expectedFor("a", true)).toThrow(/checked again/);

    protocol.recordConflict("a", conflict);

    expect(protocol.expectedFor("a", true)).toBe(conflict);
  });

  it("clears the conflict on a successful save, and records the new snapshot", () => {
    const protocol = createWriteProtocol();
    const conflict = fakeSnapshot("conflict");
    const saved = fakeSnapshot("saved");

    protocol.recordConflict("a", conflict);
    protocol.recordSaved("a", saved);

    expect(() => protocol.expectedFor("a", true)).toThrow(/checked again/);
    expect(protocol.expectedFor("a", false)).toBe(saved);
  });

  it("does not leave a snapshot behind for a fresh id recorded with an undefined read", () => {
    const protocol = createWriteProtocol();

    protocol.recordRead("a", undefined);

    expect(() => protocol.expectedFor("a", false)).toThrow(/Reopen this file before saving/);
  });

  it("clear() empties both the write and conflict snapshots", () => {
    const protocol = createWriteProtocol();
    protocol.recordRead("a", fakeSnapshot("read"));
    protocol.recordConflict("b", fakeSnapshot("conflict"));

    protocol.clear();

    expect(() => protocol.expectedFor("a", false)).toThrow(/Reopen this file before saving/);
    expect(() => protocol.expectedFor("b", true)).toThrow(/checked again/);
  });
});
