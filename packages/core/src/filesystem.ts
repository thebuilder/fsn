export type FsKind = "file" | "directory";

export type FileCategory =
  | "directory"
  | "code"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "archive"
  | "model"
  | "font"
  | "system"
  | "unknown";

/**
 * An adapter-owned reference to the bytes or directory represented by a node.
 *
 * Core deliberately treats the identifier as opaque. Browser and desktop adapters
 * resolve it to their own resource type without putting platform objects in the tree.
 */
export type FsResource = {
  id: string;
  readable: boolean;
};

export type FsNode = {
  id: string;
  parentId: string | null;
  name: string;
  kind: FsKind;
  size?: number;
  modified?: number;
  children?: FsNode[];
  resource?: FsResource;
  /** Attribution for a licensed demo asset. Shown by the viewer that opens it. */
  demoCredit?: { text: string; href?: string };
  /** Cheap listing used to size and preview this directory from the outside. */
  peek?: DirectoryPeek;
};

/** What a directory looks like from the outside: how much it holds, and of what kinds. */
export type DirectoryPeek = {
  total: number;
  /** Category per child, in listing order, capped at `DIRECTORY_PEEK_LIMIT`. */
  categories: FileCategory[];
};

/** No preview draws more markers than this, so there is nothing to gain by reading further. */
export const DIRECTORY_PEEK_LIMIT = 64;

export type FilesystemRoot = {
  root: FsNode;
  sourceLabel: string;
  isLocal: boolean;
};

const codeExtensions = new Set([
  "astro", "bash", "bat", "c", "cfg", "cjs", "clj", "cljs", "cmd", "conf", "cpp", "cs", "css", "cts", "dart", "diff", "elm", "erl", "ex", "exs", "fish", "fs", "go", "gql", "gradle", "graphql", "groovy", "h", "hcl", "hpp", "hs", "html", "ini", "java", "jl", "js", "json", "json5", "jsonc", "jsx", "kt", "kts", "less", "lua", "mjs", "mts", "mdx", "nim", "patch", "php", "pl", "properties", "proto", "ps1", "py", "r", "rb", "rs", "sass", "scala", "scss", "sh", "sql", "styl", "svelte", "swift", "tf", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml", "zig", "zsh",
]);
const imageExtensions = new Set(["apng", "avif", "bmp", "gif", "ico", "jfif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const audioExtensions = new Set(["aac", "aiff", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"]);
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "ogv", "webm"]);
const documentExtensions = new Set(["csv", "doc", "docx", "log", "md", "nfo", "pdf", "rtf", "text", "tsv", "txt"]);
const archiveExtensions = new Set(["7z", "bz2", "dmg", "gz", "iso", "jar", "rar", "tar", "tgz", "zip"]);
const modelExtensions = new Set(["glb", "gltf", "obj", "ply", "stl"]);
const fontExtensions = new Set(["otf", "ttf", "woff", "woff2"]);
const systemExtensions = new Set(["app", "bin", "dat", "dll", "dylib", "exe", "pkg", "so"]);
const textExtensions = new Set([...codeExtensions, "csv", "log", "md", "nfo", "rtf", "text", "tsv", "txt"]);

/**
 * Files whose type lives in the name rather than an extension. Without these, an
 * everyday repository is mostly ACCESS DENIED screens: Makefile, LICENSE and every
 * dotfile fall through `extensionOf` with nothing to classify.
 */
const namedFiles = new Map<string, FileCategory>([
  ...["makefile", "dockerfile", "containerfile", "justfile", "rakefile", "gemfile", "podfile", "procfile", "brewfile", "vagrantfile", "jenkinsfile"].map((name) => [name, "code"] as const),
  ...[".babelrc", ".browserslistrc", ".dockerignore", ".editorconfig", ".env", ".eslintrc", ".gitattributes", ".gitignore", ".gitmodules", ".htaccess", ".npmrc", ".nvmrc", ".prettierrc", ".yarnrc"].map((name) => [name, "code"] as const),
  ...["authors", "changelog", "changes", "codeowners", "contributing", "contributors", "copying", "install", "license", "licence", "news", "notice", "readme", "todo", "version"].map((name) => [name, "document"] as const),
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Classifies files that carry no usable extension, including scoped dotfiles like `.env.local`. */
function namedCategory(name: string): FileCategory | undefined {
  const lower = name.toLowerCase();
  const direct = namedFiles.get(lower);
  if (direct) return direct;
  if (!lower.startsWith(".")) return undefined;
  const scope = lower.indexOf(".", 1);
  return scope > 0 ? namedFiles.get(lower.slice(0, scope)) : undefined;
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
  if (modelExtensions.has(extension)) return "model";
  if (fontExtensions.has(extension)) return "font";
  if (systemExtensions.has(extension)) return "system";
  return namedCategory(node.name) ?? "unknown";
}

/**
 * Whether anything can actually be read from the node. Demo entries that exist only
 * as metadata answer false, so no viewer is asked to decode an object with no bytes.
 */
export function hasBytes(node: FsNode): boolean {
  return node.kind === "file" && node.resource?.readable === true;
}

export function canReadAsText(node: FsNode): boolean {
  if (node.kind !== "file") return false;
  const extension = extensionOf(node.name);
  return extension ? textExtensions.has(extension) : namedCategory(node.name) !== undefined;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return "-";
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

export type SearchMatch = {
  node: FsNode;
  /** Directory chain from the filesystem root down to the match's parent. */
  trail: FsNode[];
};

export type SearchOutcome = {
  matches: SearchMatch[];
  /** Every match found, including the ones trimmed off by the limit. */
  total: number;
  /** Directories that exist but have not been read from disk yet, so their contents are invisible. */
  unreadDirectories: number;
  /** False when the walk hit its ceiling, so the counts above are lower bounds. */
  complete: boolean;
};

/** Ceiling on how many nodes a single query may walk, so a huge tree cannot freeze the frame. */
const searchVisitLimit = 20000;
/** Candidates kept for ranking; anything past this is counted but never shown. */
const searchCandidateLimit = 200;

/**
 * Walks the whole subtree under `base` (an ancestry chain ending at the directory to
 * search), breadth-first so shallow matches are found first. It only descends into
 * directories already read into memory; searching never triggers new disk access.
 */
export function searchFilesystem(
  base: FsNode[],
  query: string,
  options: { limit: number },
): SearchOutcome {
  const normalized = query.trim().toLowerCase();
  const candidates: SearchMatch[] = [];
  const queue: FsNode[][] = [base];
  let total = 0;
  let unreadDirectories = 0;
  let visited = 0;
  let complete = true;

  while (queue.length) {
    const trail = queue.shift() as FsNode[];
    const children = sortNodes(trail[trail.length - 1].children ?? []);
    for (const node of children) {
      visited += 1;
      if (visited > searchVisitLimit) {
        complete = false;
        queue.length = 0;
        break;
      }
      if (!normalized || node.name.toLowerCase().includes(normalized)) {
        total += 1;
        if (candidates.length < searchCandidateLimit) candidates.push({ node, trail });
      }
      if (node.kind !== "directory") continue;
      if (node.children) queue.push([...trail, node]);
      else unreadDirectories += 1;
    }
  }

  candidates.sort((a, b) => {
    const rank = matchRank(a.node.name, normalized) - matchRank(b.node.name, normalized);
    if (rank !== 0) return rank;
    if (a.trail.length !== b.trail.length) return a.trail.length - b.trail.length;
    if (a.node.kind !== b.node.kind) return a.node.kind === "directory" ? -1 : 1;
    return a.node.name.localeCompare(b.node.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return { matches: candidates.slice(0, options.limit), total, unreadDirectories, complete };
}

/** Name matches sort ahead of the rest: whole prefix, then word start, then anywhere. */
function matchRank(name: string, query: string): number {
  if (!query) return 2;
  const index = name.toLowerCase().indexOf(query);
  if (index === 0) return 0;
  return index > 0 && /[\s._\-/]/.test(name[index - 1]) ? 1 : 2;
}

export function pathFor(node: FsNode, ancestry: FsNode[]): string {
  const index = ancestry.findIndex((ancestor) => ancestor.id === node.parentId);
  const base = index >= 0 ? ancestry.slice(0, index + 1).map((part) => part.name) : ancestry.map((part) => part.name);
  return `/${[...base, node.name].join("/")}`;
}
