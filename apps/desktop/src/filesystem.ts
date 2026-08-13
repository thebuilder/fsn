import { invoke } from "@tauri-apps/api/core";
import {
  DIRECTORY_PEEK_LIMIT,
  categoryOf,
  sortNodes,
  type DirectoryPeek,
  type FilesystemRoot,
  type FsNode,
} from "@fsn/core";

const MAX_BROWSER_READ_BYTES = 256 * 1024 * 1024;

type NativeEntry = {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
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

  const entries = await invoke<NativeEntry[]>("read_dir_native", { path });
  const children: FsNode[] = entries.map((entry) => {
    const isDirectory = entry.isDirectory && !entry.isSymlink;
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
}

export async function peekChildren(node: FsNode): Promise<DirectoryPeek> {
  if (node.peek) return node.peek;
  if (node.kind !== "directory") return { total: 0, categories: [] };
  if (node.children) {
    node.peek = {
      total: node.children.length,
      categories: node.children.slice(0, DIRECTORY_PEEK_LIMIT).map(categoryOf),
    };
    return node.peek;
  }

  const path = desktopDirectoryPath(node);
  if (!path) return { total: 0, categories: [] };
  try {
    const entries = await invoke<NativeEntry[]>("read_dir_native", { path });
    node.peek = {
      total: entries.length,
      categories: entries.slice(0, DIRECTORY_PEEK_LIMIT).map((entry) =>
        categoryOf({
          id: entry.path,
          parentId: node.id,
          name: entry.name,
          kind: entry.isDirectory && !entry.isSymlink ? "directory" : "file",
        }),
      ),
    };
  } catch {
    node.peek = { total: 0, categories: [] };
  }
  return node.peek;
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
      };
  signal?.throwIfAborted();
  const payload = loaded.bytes instanceof ArrayBuffer
    ? new Uint8Array(loaded.bytes)
    : Uint8Array.from(loaded.bytes);
  node.size = payload.byteLength;
  return {
    blob: new Blob([payload], { type: desktopMimeType(node.name) }),
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
  await invoke("open_native", { path: desktopFilePath(node) });
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

function desktopMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return ({
    aac: "audio/aac", aiff: "audio/aiff", apng: "image/apng", avif: "image/avif",
    avi: "video/x-msvideo", bmp: "image/bmp", flac: "audio/flac", gif: "image/gif",
    ico: "image/x-icon", jpeg: "image/jpeg", jpg: "image/jpeg", m4a: "audio/mp4",
    m4v: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", mp3: "audio/mpeg",
    mp4: "video/mp4", mpeg: "video/mpeg", oga: "audio/ogg", ogg: "audio/ogg",
    ogv: "video/ogg", opus: "audio/opus", pdf: "application/pdf", png: "image/png",
    svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", wav: "audio/wav",
    weba: "audio/webm", webm: "video/webm", webp: "image/webp",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function normalizeSnapshot(snapshot: NativeFileSnapshot): DesktopFileSnapshot {
  return {
    ...snapshot,
    modified: snapshot.modified ?? undefined,
    modifiedNs: snapshot.modifiedNs ?? undefined,
  };
}
