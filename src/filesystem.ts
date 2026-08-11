export type FsKind = "file" | "directory";

export type FileCategory =
  | "directory"
  | "code"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "archive"
  | "system"
  | "unknown";

export type FsNode = {
  id: string;
  parentId: string | null;
  name: string;
  kind: FsKind;
  size?: number;
  modified?: number;
  children?: FsNode[];
  file?: File;
  handle?: FileSystemHandle;
  demoContent?: string;
  demoImage?: string;
};

export type FilesystemRoot = {
  root: FsNode;
  sourceLabel: string;
  isLocal: boolean;
};

const codeExtensions = new Set([
  "c", "cpp", "css", "go", "h", "html", "java", "js", "json", "jsx", "mdx", "py", "rb", "rs", "scss", "sh", "sql", "swift", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml",
]);
const imageExtensions = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const audioExtensions = new Set(["aac", "aiff", "flac", "m4a", "mp3", "ogg", "wav"]);
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "webm"]);
const documentExtensions = new Set(["csv", "doc", "docx", "log", "md", "pdf", "rtf", "txt"]);
const archiveExtensions = new Set(["7z", "bz2", "dmg", "gz", "iso", "rar", "tar", "tgz", "zip"]);
const systemExtensions = new Set(["app", "bin", "dat", "dll", "dylib", "exe", "pkg", "so"]);
const textExtensions = new Set([...codeExtensions, "csv", "log", "md", "rtf", "txt"]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function categoryOf(node: FsNode): FileCategory {
  if (node.kind === "directory") return "directory";
  const extension = extensionOf(node.name);
  if (codeExtensions.has(extension)) return "code";
  if (imageExtensions.has(extension)) return "image";
  if (audioExtensions.has(extension)) return "audio";
  if (videoExtensions.has(extension)) return "video";
  if (documentExtensions.has(extension)) return "document";
  if (archiveExtensions.has(extension)) return "archive";
  if (systemExtensions.has(extension)) return "system";
  return "unknown";
}

export function canReadAsText(node: FsNode): boolean {
  return node.kind === "file" && textExtensions.has(extensionOf(node.name));
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
}

export function sortNodes(nodes: FsNode[]): FsNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function pathFor(node: FsNode, ancestry: FsNode[]): string {
  const index = ancestry.findIndex((ancestor) => ancestor.id === node.parentId);
  const base = index >= 0 ? ancestry.slice(0, index + 1).map((part) => part.name) : ancestry.map((part) => part.name);
  return `/${[...base, node.name].join("/")}`;
}

type DirectoryHandleWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export async function openBrowserDirectory(): Promise<FilesystemRoot | null> {
  const pickerWindow = window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  };
  if (!pickerWindow.showDirectoryPicker) return null;
  const handle = await pickerWindow.showDirectoryPicker({ mode: "read" });
  const root: FsNode = {
    id: `local:${encodeURIComponent(handle.name)}`,
    parentId: null,
    name: handle.name,
    kind: "directory",
    handle,
  };
  root.children = await readHandleChildren(root);
  return { root, sourceLabel: "LOCAL DIRECTORY / READ ONLY", isLocal: true };
}

export async function ensureChildren(node: FsNode): Promise<FsNode[]> {
  if (node.children) return node.children;
  if (node.kind !== "directory" || node.handle?.kind !== "directory") return [];
  node.children = await readHandleChildren(node);
  return node.children;
}

async function readHandleChildren(parent: FsNode): Promise<FsNode[]> {
  const children: FsNode[] = [];
  const directory = parent.handle as DirectoryHandleWithEntries;
  for await (const [name, handle] of directory.entries()) {
    const node: FsNode = {
      id: `${parent.id}/${encodeURIComponent(name)}`,
      parentId: parent.id,
      name,
      kind: handle.kind,
      handle,
    };
    if (handle.kind === "file") {
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        node.file = file;
        node.size = file.size;
        node.modified = file.lastModified;
      } catch {
        // Metadata can be denied independently; the node remains navigable.
      }
    }
    children.push(node);
  }
  return sortNodes(children);
}

export function rootFromFileList(files: FileList): FilesystemRoot | null {
  const items = Array.from(files);
  if (!items.length) return null;
  const firstPath = items[0].webkitRelativePath || items[0].name;
  const rootName = firstPath.split("/")[0] || "Imported folder";
  const root: FsNode = { id: `import:${encodeURIComponent(rootName)}`, parentId: null, name: rootName, kind: "directory", children: [] };
  const directories = new Map<string, FsNode>([[rootName, root]]);

  for (const file of items) {
    const segments = (file.webkitRelativePath || file.name).split("/");
    let current = root;
    let currentPath = rootName;
    for (let index = 1; index < segments.length - 1; index += 1) {
      const name = segments[index];
      currentPath += `/${name}`;
      let directory = directories.get(currentPath);
      if (!directory) {
        directory = { id: `import:${encodeURIComponent(currentPath)}`, parentId: current.id, name, kind: "directory", children: [] };
        directories.set(currentPath, directory);
        current.children?.push(directory);
      }
      current = directory;
    }
    current.children?.push({
      id: `import:${encodeURIComponent(file.webkitRelativePath || file.name)}`,
      parentId: current.id,
      name: file.name,
      kind: "file",
      size: file.size,
      modified: file.lastModified,
      file,
    });
  }
  for (const directory of directories.values()) directory.children = sortNodes(directory.children ?? []);
  return { root, sourceLabel: "LOCAL SNAPSHOT / READ ONLY", isLocal: true };
}
