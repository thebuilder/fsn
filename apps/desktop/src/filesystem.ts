import { invoke } from "@tauri-apps/api/core";
import {
  DIRECTORY_PEEK_LIMIT,
  categoryOf,
  mimeTypeFor,
  peekFromChildren,
  sortNodes,
  type DirectoryPeek,
  type DirectoryUsage,
  type FilesystemRoot,
  type FsNode,
  type GitStatusReport,
} from "@fsn/core";

const MAX_BROWSER_READ_BYTES = 256 * 1024 * 1024;

type NativeEntry = {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  isNativeBundle: boolean;
  size: number;
  modified: number | null;
  readonly: boolean;
  readable: boolean;
  canEditText: boolean;
  canOpenNative: boolean;
};

type PickedRoot = {
  path: string;
  entry: NativeEntry;
};

const nativeCapabilities = new Map<string, { canEditText: boolean; canOpenNative: boolean }>();

/**
 * Two callers racing the same directory must share one read, or the loser's node graph
 * leaks into navigation state while the winner's result is the one actually stored.
 */
const childrenInFlight = new Map<string, Promise<FsNode[]>>();
const peekInFlight = new Map<string, Promise<DirectoryPeek>>();

export type DesktopFileSnapshot = {
  size: number;
  modified?: number;
  modifiedNs?: string;
  identity: string;
  sha256: string;
  securityMetadata: string;
};

export type DesktopWriteResult =
  | { status: "saved"; snapshot: DesktopFileSnapshot }
  | { status: "conflict"; actual: DesktopFileSnapshot };

type NativeWriteResult =
  | { status: "saved"; snapshot: NativeFileSnapshot }
  | { status: "conflict"; actual: NativeFileSnapshot };

export type DesktopReadResult = {
  blob: Blob;
  snapshot?: DesktopFileSnapshot;
};

type NativeFileSnapshot = Omit<DesktopFileSnapshot, "modified" | "modifiedNs"> & {
  modified: number | null;
  modifiedNs: string | null;
};

type NativeTextReadResult = {
  bytes: ArrayBuffer | number[];
  snapshot: NativeFileSnapshot;
  isUtf8: boolean;
};

/** Opens a native folder picker and atomically replaces the active Rust grant. */
export async function openDesktopDirectory(): Promise<FilesystemRoot | null> {
  const picked = await invoke<PickedRoot | null>("pick_root");
  if (!picked) return null;
  const root: FsNode = {
    id: picked.path,
    parentId: null,
    name: picked.entry.name,
    kind: "directory",
    modified: picked.entry.modified ?? undefined,
    resource: { id: picked.path, readable: false },
  };
  nativeCapabilities.clear();
  return { root, sourceLabel: "LOCAL DIRECTORY / DESKTOP", isLocal: true };
}

export async function clearDesktopRoot(): Promise<void> {
  await invoke("clear_active_root");
  nativeCapabilities.clear();
}

export async function ensureChildren(parent: FsNode): Promise<FsNode[]> {
  if (parent.children) return parent.children;
  const path = desktopDirectoryPath(parent);
  if (!path) return [];

  const inFlight = childrenInFlight.get(parent.id);
  if (inFlight) return inFlight;
  const read = (async () => {
    const entries = await invoke<NativeEntry[]>("read_dir_native", { path });
    const children: FsNode[] = entries.map((entry) => {
      const isDirectory = entry.isDirectory && !entry.isSymlink && !entry.isNativeBundle;
      const node: FsNode = {
        id: entry.path,
        parentId: parent.id,
        name: entry.name,
        kind: isDirectory ? "directory" : "file",
        size: entry.isFile ? entry.size : undefined,
        modified: entry.modified ?? undefined,
        resource: { id: entry.path, readable: entry.isFile && !entry.isSymlink && entry.readable },
      };
      nativeCapabilities.set(entry.path, {
        canEditText: entry.canEditText,
        canOpenNative: entry.canOpenNative,
      });
      return node;
    });

    parent.children = sortNodes(children);
    return parent.children;
  })();
  childrenInFlight.set(parent.id, read);
  try {
    return await read;
  } finally {
    childrenInFlight.delete(parent.id);
  }
}

export async function peekChildren(node: FsNode): Promise<DirectoryPeek> {
  if (node.peek) return node.peek;
  if (node.kind !== "directory") return { total: 0, categories: [] };
  if (node.children) {
    node.peek = peekFromChildren(node.children);
    return node.peek;
  }

  const path = desktopDirectoryPath(node);
  if (!path) return { total: 0, categories: [] };

  const inFlight = peekInFlight.get(node.id);
  if (inFlight) return inFlight;
  const read = (async () => {
    try {
      const entries = await invoke<NativeEntry[]>("read_dir_native", { path });
      const shown = entries.slice(0, DIRECTORY_PEEK_LIMIT);
      node.peek = {
        total: entries.length,
        categories: shown.map((entry) =>
          categoryOf({
            id: entry.path,
            parentId: node.id,
            name: entry.name,
            kind: entry.isDirectory && !entry.isSymlink && !entry.isNativeBundle ? "directory" : "file",
          }),
        ),
        // The native listing already stat'ed every entry, so the markers get their
        // names and times for free.
        names: shown.map((entry) => entry.name),
        modified: shown.map((entry) => entry.modified ?? undefined),
      };
    } catch {
      node.peek = { total: 0, categories: [] };
    }
    return node.peek;
  })();
  peekInFlight.set(node.id, read);
  try {
    return await read;
  } finally {
    peekInFlight.delete(node.id);
  }
}

type NativeUsage = Omit<DirectoryUsage, "newest"> & { newest: number | null };

/**
 * Totals everything beneath a directory through the native walk, which validates the
 * path against the active root, never follows links, and caps itself. The IPC call
 * cannot be recalled once sent, so cancelling only discards its answer.
 */
export async function measureDesktopDirectory(node: FsNode, signal: AbortSignal): Promise<DirectoryUsage> {
  const path = desktopDirectoryPath(node);
  if (!path) throw new Error("This directory has no native path in the current session.");
  signal.throwIfAborted();
  const usage = await invoke<NativeUsage>("measure_dir_native", { path });
  signal.throwIfAborted();
  return { ...usage, newest: usage.newest ?? undefined };
}

/** The active root's git status; the backend decides the root, so nothing is passed. */
export async function readDesktopGitStatus(): Promise<GitStatusReport | null> {
  return invoke<GitStatusReport | null>("git_status_native");
}

export async function readDesktopResource(
  node: FsNode,
  signal?: AbortSignal,
): Promise<DesktopReadResult> {
  const path = desktopFilePath(node);
  signal?.throwIfAborted();
  const loaded = canEditDesktopText(node)
    ? await invoke<NativeTextReadResult>("read_text_native", { path })
    : {
        bytes: await invoke<ArrayBuffer | number[]>("read_file_native", {
          path,
          maxBytes: MAX_BROWSER_READ_BYTES,
        }),
        snapshot: undefined,
        isUtf8: true,
      };
  signal?.throwIfAborted();
  const payload = loaded.bytes instanceof ArrayBuffer
    ? new Uint8Array(loaded.bytes)
    : Uint8Array.from(loaded.bytes);
  node.size = payload.byteLength;
  if (loaded.snapshot && !loaded.isUtf8) {
    // A snapshot arms the write path's atomic-save flow. Bytes the editor cannot
    // faithfully round-trip through UTF-8 must never carry a snapshot forward, or a
    // later save could silently corrupt the file's non-UTF-8 content.
    if (node.resource) {
      const existing = nativeCapabilities.get(node.resource.id);
      nativeCapabilities.set(node.resource.id, {
        canEditText: false,
        canOpenNative: existing?.canOpenNative ?? false,
      });
    }
    return {
      blob: new Blob([payload], { type: mimeTypeFor(node.name) }),
      snapshot: undefined,
    };
  }
  return {
    blob: new Blob([payload], { type: mimeTypeFor(node.name) }),
    snapshot: loaded.snapshot ? normalizeSnapshot(loaded.snapshot) : undefined,
  };
}

/** Rust compares a full content/identity/security snapshot before atomic commit. */
export async function writeDesktopText(
  node: FsNode,
  text: string,
  expected: DesktopFileSnapshot,
): Promise<DesktopWriteResult> {
  const result = await invoke<NativeWriteResult>("write_text_atomic", {
    path: desktopFilePath(node),
    text,
    expected,
  });
  if (result.status === "conflict") {
    return { status: "conflict", actual: normalizeSnapshot(result.actual) };
  }
  const snapshot = normalizeSnapshot(result.snapshot);
  node.size = snapshot.size;
  node.modified = snapshot.modified;
  return { status: "saved", snapshot };
}

export async function openDesktopNative(node: FsNode): Promise<void> {
  await invoke("open_native", { path: desktopNativePath(node) });
}

export function canEditDesktopText(node: FsNode): boolean {
  return Boolean(node.resource && nativeCapabilities.get(node.resource.id)?.canEditText);
}

export function canOpenDesktopNative(node: FsNode): boolean {
  return Boolean(node.resource && nativeCapabilities.get(node.resource.id)?.canOpenNative);
}

function desktopDirectoryPath(node: FsNode): string | null {
  if (node.kind !== "directory" || !node.resource?.id) return null;
  return node.resource.id;
}

function desktopFilePath(node: FsNode): string {
  if (node.kind !== "file" || !node.resource?.readable || !node.resource.id) {
    throw new Error("This object has no readable native file in the current session.");
  }
  return node.resource.id;
}

function desktopNativePath(node: FsNode): string {
  if (node.kind !== "file" || !node.resource?.id) {
    throw new Error("This object cannot be opened in a native application.");
  }
  return node.resource.id;
}

function normalizeSnapshot(snapshot: NativeFileSnapshot): DesktopFileSnapshot {
  return {
    ...snapshot,
    modified: snapshot.modified ?? undefined,
    modifiedNs: snapshot.modifiedNs ?? undefined,
  };
}
