import type { DesktopFileSnapshot } from "./filesystem";

/**
 * Tracks the atomic-save bookkeeping for the desktop write path: which snapshot a
 * write should be checked against, and which snapshot a conflicting external edit
 * left behind for a forced retry to check against instead.
 */
export type WriteProtocol = {
  /** Records the snapshot a read produced. A missing snapshot (e.g. a non-UTF-8
   * read) is not stored and does not clear any existing entry — mirroring the
   * live read path, which only ever touches the maps when a snapshot is present. */
  recordRead(id: string, snapshot: DesktopFileSnapshot | undefined): void;
  /** Returns the snapshot a save should be checked against, or throws one of the
   * two guard errors if the caller has not earned the right to save yet. */
  expectedFor(id: string, force: boolean): DesktopFileSnapshot;
  /** Records the on-disk snapshot a conflicting write revealed, so a forced retry
   * has something to check against. */
  recordConflict(id: string, actual: DesktopFileSnapshot): void;
  /** Records a successful save's new snapshot and clears any prior conflict. */
  recordSaved(id: string, snapshot: DesktopFileSnapshot): void;
  /** Clears all tracked state, e.g. when the active root changes. */
  clear(): void;
};

export function createWriteProtocol(): WriteProtocol {
  const writeSnapshots = new Map<string, DesktopFileSnapshot>();
  const conflictSnapshots = new Map<string, DesktopFileSnapshot>();

  return {
    recordRead(id, snapshot) {
      if (snapshot) {
        writeSnapshots.set(id, snapshot);
        conflictSnapshots.delete(id);
      }
    },
    expectedFor(id, force) {
      let expected: DesktopFileSnapshot | undefined;
      if (force) {
        expected = conflictSnapshots.get(id);
        if (!expected) {
          throw new Error("The changed file must be checked again before retrying the save.");
        }
      } else {
        expected = writeSnapshots.get(id);
      }
      if (!expected) {
        throw new Error("Reopen this file before saving so FSN can verify its original revision.");
      }
      return expected;
    },
    recordConflict(id, actual) {
      conflictSnapshots.set(id, actual);
    },
    recordSaved(id, snapshot) {
      conflictSnapshots.delete(id);
      writeSnapshots.set(id, snapshot);
    },
    clear() {
      writeSnapshots.clear();
      conflictSnapshots.clear();
    },
  };
}
