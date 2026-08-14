import {
  DIRECTORY_PEEK_LIMIT,
  categoryOf,
  sortNodes,
  type DirectoryPeek,
  type FilesystemRoot,
  type FsNode,
  type FsResource,
} from "@fsn/core";

export * from "@fsn/core";

type DirectoryHandleWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

type BrowserResource =
  | { kind: "directory"; handle: FileSystemDirectoryHandle }
  | { kind: "file-handle"; handle: FileSystemFileHandle }
  | { kind: "file"; file: File }
  | { kind: "text"; content: string }
  | { kind: "url"; url: string };

/** Browser objects live here rather than in the platform-neutral filesystem tree. */
const browserResources = new Map<string, BrowserResource>();
let sourceSequence = 0;

/**
 * Two callers racing the same directory must share one read, or the loser's node graph
 * leaks into navigation state while the winner's result is the one actually stored.
 */
const childrenInFlight = new Map<string, Promise<FsNode[]>>();
const peekInFlight = new Map<string, Promise<DirectoryPeek>>();

function sourceId(prefix: "local" | "import", name: string): string {
  sourceSequence += 1;
  return `${prefix}:${sourceSequence}:${encodeURIComponent(name)}`;
}

function registerResource(id: string, resource: BrowserResource, readable: boolean): FsResource {
  browserResources.set(id, resource);
  return { id, readable };
}

export function registerBrowserTextResource(id: string, content: string): FsResource {
  return registerResource(id, { kind: "text", content }, true);
}

export function registerBrowserUrlResource(id: string, url: string): FsResource {
  return registerResource(id, { kind: "url", url }, true);
}

/** Drops browser objects owned by a source after the navigator switches away from it. */
export function disposeBrowserFilesystem(filesystem: FilesystemRoot): void {
  const visit = (node: FsNode): void => {
    if (node.resource) browserResources.delete(node.resource.id);
    for (const child of node.children ?? []) visit(child);
  };
  visit(filesystem.root);
}

/** Returns a URL that is already browser-addressable, avoiding an unnecessary fetch/blob round trip. */
export function browserResourceUrl(node: FsNode): string | null {
  if (!node.resource?.readable) return null;
  const resource = browserResources.get(node.resource.id);
  return resource?.kind === "url" ? resource.url : null;
}

/** Resolves the opaque core reference only inside the browser adapter. */
export async function readBrowserResource(node: FsNode, signal?: AbortSignal): Promise<Blob> {
  if (node.kind !== "file" || !node.resource?.readable) {
    throw new Error("This object has no readable bytes in the current session.");
  }
  signal?.throwIfAborted();
  const resource = browserResources.get(node.resource.id);
  if (!resource) throw new Error("This object's browser resource is no longer available.");

  if (resource.kind === "file") return resource.file;
  if (resource.kind === "file-handle") return resource.handle.getFile();
  if (resource.kind === "text") return new Blob([resource.content], { type: "text/plain" });
  if (resource.kind === "url") {
    const response = await fetch(resource.url, { signal });
    if (!response.ok) throw new Error(`Demo object unavailable (HTTP ${response.status}).`);
    return response.blob();
  }
  throw new Error("Directories do not expose a byte payload.");
}

export function directoryHandleFor(node: FsNode): FileSystemDirectoryHandle | null {
  if (!node.resource) return null;
  const resource = browserResources.get(node.resource.id);
  return resource?.kind === "directory" ? resource.handle : null;
}

export async function openBrowserDirectory(): Promise<FilesystemRoot | null> {
  const pickerWindow = window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  };
  if (!pickerWindow.showDirectoryPicker) return null;
  return rootFromDirectoryHandle(await pickerWindow.showDirectoryPicker({ mode: "read" }));
}

/**
 * Builds a filesystem around an already-authorized handle, whether it came from the
 * picker just now or out of storage from an earlier visit. Reading it here is what
 * proves the directory is still both present and permitted.
 */
export async function rootFromDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<FilesystemRoot> {
  const id = sourceId("local", handle.name);
  const root: FsNode = {
    id,
    parentId: null,
    name: handle.name,
    kind: "directory",
    resource: registerResource(id, { kind: "directory", handle }, false),
  };
  root.children = await readHandleChildren(root);
  return { root, sourceLabel: "LOCAL DIRECTORY / READ ONLY", isLocal: true };
}

export async function ensureChildren(node: FsNode): Promise<FsNode[]> {
  if (node.children) return node.children;
  if (node.kind !== "directory" || !directoryHandleFor(node)) return [];
  const inFlight = childrenInFlight.get(node.id);
  if (inFlight) return inFlight;
  const read = (async () => {
    node.children = await readHandleChildren(node);
    return node.children;
  })();
  childrenInFlight.set(node.id, read);
  try {
    return await read;
  } finally {
    childrenInFlight.delete(node.id);
  }
}

/**
 * Summarises a directory without opening any file inside it.
 *
 * `ensureChildren` calls `getFile()` on every entry to learn its size, which is far too
 * expensive to run across every sub-directory of the folder you just walked into merely
 * to draw its preview. Enumerating entries is a readdir; categories come from the names.
 * Deliberately does not populate `children`, so a later real read still collects sizes.
 */
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

  const inFlight = peekInFlight.get(node.id);
  if (inFlight) return inFlight;
  const read = (async () => {
    const peek: DirectoryPeek = { total: 0, categories: [] };
    const handle = directoryHandleFor(node);
    if (handle) {
      try {
        const directory = handle as DirectoryHandleWithEntries;
        for await (const [name, childHandle] of directory.entries()) {
          peek.total += 1;
          if (peek.categories.length < DIRECTORY_PEEK_LIMIT) {
            peek.categories.push(categoryOf({ id: name, parentId: node.id, name, kind: childHandle.kind }));
          }
        }
      } catch {
        // A directory we are not allowed to list simply previews as empty land.
      }
    }
    node.peek = peek;
    return peek;
  })();
  peekInFlight.set(node.id, read);
  try {
    return await read;
  } finally {
    peekInFlight.delete(node.id);
  }
}

/** Resolves file metadata a pool at a time: one slow handle stalls its slot, not the directory. */
async function fillFileMetadata(pending: { node: FsNode; handle: FileSystemFileHandle }[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const { node, handle } = pending[next];
      next += 1;
      try {
        const file = await handle.getFile();
        node.resource = registerResource(node.id, { kind: "file", file }, true);
        node.size = file.size;
        node.modified = file.lastModified;
      } catch {
        // Metadata can be denied independently; the node remains navigable.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, pending.length) }, worker));
}

async function readHandleChildren(parent: FsNode): Promise<FsNode[]> {
  const children: FsNode[] = [];
  const handle = directoryHandleFor(parent);
  if (!handle) return children;
  const directory = handle as DirectoryHandleWithEntries;
  const pending: { node: FsNode; handle: FileSystemFileHandle }[] = [];
  for await (const [name, childHandle] of directory.entries()) {
    const id = `${parent.id}/${encodeURIComponent(name)}`;
    const node: FsNode = {
      id,
      parentId: parent.id,
      name,
      kind: childHandle.kind,
      resource: registerResource(
        id,
        childHandle.kind === "directory"
          ? { kind: "directory", handle: childHandle as FileSystemDirectoryHandle }
          : { kind: "file-handle", handle: childHandle as FileSystemFileHandle },
        false,
      ),
    };
    if (childHandle.kind === "file") {
      pending.push({ node, handle: childHandle as FileSystemFileHandle });
    }
    children.push(node);
  }
  await fillFileMetadata(pending);
  return sortNodes(children);
}

export function rootFromFileList(files: FileList): FilesystemRoot | null {
  const items = Array.from(files);
  if (!items.length) return null;
  const firstPath = items[0].webkitRelativePath || items[0].name;
  const rootName = firstPath.split("/")[0] || "Imported folder";
  const rootId = sourceId("import", rootName);
  const root: FsNode = { id: rootId, parentId: null, name: rootName, kind: "directory", children: [] };
  const directories = new Map<string, FsNode>([[rootName, root]]);

  for (const file of items) {
    const path = file.webkitRelativePath || file.name;
    const segments = path.split("/");
    let current = root;
    let currentPath = rootName;
    for (let index = 1; index < segments.length - 1; index += 1) {
      const name = segments[index];
      currentPath += `/${name}`;
      let directory = directories.get(currentPath);
      if (!directory) {
        directory = { id: `${rootId}/${encodeURIComponent(currentPath)}`, parentId: current.id, name, kind: "directory", children: [] };
        directories.set(currentPath, directory);
        current.children?.push(directory);
      }
      current = directory;
    }
    const id = `${rootId}/${encodeURIComponent(path)}`;
    current.children?.push({
      id,
      parentId: current.id,
      name: file.name,
      kind: "file",
      size: file.size,
      modified: file.lastModified,
      resource: registerResource(id, { kind: "file", file }, true),
    });
  }
  for (const directory of directories.values()) directory.children = sortNodes(directory.children ?? []);
  return { root, sourceLabel: "LOCAL SNAPSHOT / READ ONLY", isLocal: true };
}
