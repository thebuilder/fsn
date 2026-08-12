import { invoke } from "@tauri-apps/api/core";
import { basename } from "@tauri-apps/api/path";
import {
  canReadAsText,
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
  modified?: number;
  readonly: boolean;
  readable: boolean;
};

type NativeMetadata = {
  size: number;
  modified?: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  readonly: boolean;
};

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

export type DesktopReadResult = {
  blob: Blob;
  snapshot?: DesktopFileSnapshot;
};

type NativeTextReadResult = {
  bytes: ArrayBuffer | number[];
  snapshot: DesktopFileSnapshot;
};

/** Opens a native folder picker and atomically replaces the active Rust grant. */
export async function openDesktopDirectory(): Promise<FilesystemRoot | null> {
  const path = await invoke<string | null>("pick_root");
  return path ? rootFromDesktopPath(path, true) : null;
}

/** Builds a lazy root only when Rust confirms it is the active native grant. */
export async function rootFromDesktopPath(
  path: string,
  alreadyAuthorized = false,
): Promise<FilesystemRoot> {
  const authorizedPath = alreadyAuthorized
    ? path
    : await invoke<string>("require_active_root", { path });
  const info = await statDesktop(authorizedPath);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error("The selected path is not a directory.");
  }

  const pathName = await basename(authorizedPath);
  const root: FsNode = {
    id: authorizedPath,
    parentId: null,
    name: pathName || authorizedPath,
    kind: "directory",
    resource: { id: authorizedPath, readable: false },
  };

  return { root, sourceLabel: "LOCAL DIRECTORY / DESKTOP", isLocal: true };
}

export async function clearDesktopRoot(): Promise<void> {
  await invoke("clear_active_root");
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
      modified: entry.modified,
      resource: { id: entry.path, readable: entry.isFile && !entry.isSymlink && entry.readable },
    };
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
  const loaded = canReadAsText(node)
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
    snapshot: loaded.snapshot,
  };
}

/** Rust compares a full content/identity/security snapshot before atomic commit. */
export async function writeDesktopText(
  node: FsNode,
  text: string,
  expected: DesktopFileSnapshot,
): Promise<DesktopWriteResult> {
  const result = await invoke<DesktopWriteResult>("write_text_atomic", {
    path: desktopFilePath(node),
    text,
    expected,
  });
  if (result.status === "saved") {
    node.size = result.snapshot.size;
    node.modified = result.snapshot.modified;
  }
  return result;
}

export async function openDesktopNative(node: FsNode): Promise<void> {
  await invoke("open_native", { path: desktopFilePath(node) });
}

function statDesktop(path: string): Promise<NativeMetadata> {
  return invoke("stat_native", { path });
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
