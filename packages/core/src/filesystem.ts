import type { DirectoryUsage } from "./usage";

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
  /** Everything beneath this directory, once something has walked it to find out. */
  usage?: DirectoryUsage;
};

/** What a directory looks like from the outside: how much it holds, and of what kinds. */
export type DirectoryPeek = {
  total: number;
  /** Category per child, in listing order, capped at `DIRECTORY_PEEK_LIMIT`. */
  categories: FileCategory[];
  /**
   * Name per child, aligned with `categories`, so a lens can say something about the
   * child a marker stands for. Optional, because a peek only has to count to do its job.
   */
  names?: string[];
  /** Modification time per child where the listing knew one, aligned with `categories`. */
  modified?: (number | undefined)[];
};

/**
 * The peek a directory's children already answer, for adapters that have read them. The
 * names and times ride along so a marker on the plot can be coloured like the object it
 * stands for.
 */
export function peekFromChildren(children: FsNode[]): DirectoryPeek {
  const shown = children.slice(0, DIRECTORY_PEEK_LIMIT);
  return {
    total: children.length,
    categories: shown.map(categoryOf),
    names: shown.map((child) => child.name),
    modified: shown.map((child) => child.modified),
  };
}

/** No preview draws more markers than this, so there is nothing to gain by reading further. */
export const DIRECTORY_PEEK_LIMIT = 64;

export type FilesystemRoot = {
  root: FsNode;
  sourceLabel: string;
  isLocal: boolean;
};

/**
 * UTF-8 source, configuration, data and template formats that are safe to hand
 * to the text viewer. This is intentionally an allow-list: extensions with
 * common binary variants (for example plist, generic lock/map, and compiled
 * protobuf files) stay out unless their textual form has an unambiguous extension
 * or filename.
 */
const codeExtensions = new Set([
  "asm", "astro", "avdl", "avsc", "awk",
  "bash", "bat", "bazel", "bzl",
  "c", "cc", "cfg", "cjs", "clj", "cljs", "cmake", "cmd", "cnf", "coffee", "conf", "cpp", "cs", "cshtml", "csproj", "css", "cts", "cu", "cue", "cuh", "cxx",
  "d", "dart", "diff", "dockerfile",
  "ejs", "elm", "env", "erb", "erl", "ex", "exs",
  "feature", "fish", "frag", "fs", "fsi", "fsproj", "fsx",
  "geojson", "glsl", "go", "gql", "gradle", "graphql", "graphqls", "groovy",
  "h", "handlebars", "har", "hbs", "hcl", "hh", "hpp", "hs", "html", "http", "hxx",
  "ini", "ipynb",
  "java", "jl", "js", "json", "json5", "jsonc", "jsonl", "jsx",
  "kt", "kts",
  "less", "liquid", "lua",
  "m", "mdx", "metal", "mjs", "mm", "mts", "mustache",
  "ndjson", "nim", "nix", "njk", "nomad",
  "pas", "patch", "php", "pl", "prisma", "properties", "props", "proto", "ps1", "pug", "py",
  "r", "razor", "rb", "rego", "resx", "robot", "rs",
  "sass", "scala", "scss", "sed", "service", "sh", "shader", "sln", "sol", "sql", "storyboard", "styl", "svelte", "swift",
  "targets", "tcl", "tf", "tfstate", "tfvars", "thrift", "toml", "ts", "tsx", "twig",
  "v", "vb", "vbproj", "vbs", "vcxproj", "vert", "vhd", "vhdl", "vue",
  "wat", "webmanifest", "wgsl", "wit",
  "xaml", "xcconfig", "xib", "xlf", "xliff", "xml", "xsd", "xslt",
  "yaml", "yml",
  "zig", "zsh",
]);
const textDocumentExtensions = [
  "adoc", "asciidoc", "ics", "log", "markdown", "md", "mdown", "mkd", "nfo", "org", "po", "pot", "qmd", "rmd", "rst", "rtf", "srt", "tex", "text", "txt", "vtt",
] as const;
const tabularTextExtensions = ["csv", "tsv"] as const;
const imageExtensions = new Set(["apng", "avif", "bmp", "gif", "ico", "jfif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const audioExtensions = new Set(["aac", "aiff", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"]);
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "ogv", "webm"]);
const documentExtensions = new Set([...tabularTextExtensions, ...textDocumentExtensions, "doc", "docx", "pdf"]);

/**
 * The single source of truth for extension -> MIME type, so a platform adapter never has to
 * hand-maintain its own map that can silently drift from the classification sets above (a
 * `.jfif` file once routed to the image viewer while typed `application/octet-stream`, because
 * the desktop app's map lacked the entry core already knew about).
 */
const extensionMimeTypes = new Map<string, string>([
  ["aac", "audio/aac"], ["aiff", "audio/aiff"], ["apng", "image/apng"], ["avif", "image/avif"],
  ["avi", "video/x-msvideo"], ["bmp", "image/bmp"], ["flac", "audio/flac"], ["gif", "image/gif"],
  ["ico", "image/x-icon"], ["jfif", "image/jpeg"], ["jpeg", "image/jpeg"], ["jpg", "image/jpeg"], ["m4a", "audio/mp4"],
  ["m4v", "video/mp4"], ["mkv", "video/x-matroska"], ["mov", "video/quicktime"], ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"], ["mpeg", "video/mpeg"], ["oga", "audio/ogg"], ["ogg", "audio/ogg"],
  ["ogv", "video/ogg"], ["opus", "audio/opus"], ["pdf", "application/pdf"], ["png", "image/png"],
  ["svg", "image/svg+xml"], ["tif", "image/tiff"], ["tiff", "image/tiff"], ["wav", "audio/wav"],
  ["weba", "audio/webm"], ["webm", "video/webm"], ["webp", "image/webp"],
]);
const archiveExtensions = new Set(["7z", "bz2", "dmg", "gz", "iso", "jar", "rar", "tar", "tgz", "zip"]);
const modelExtensions = new Set(["glb", "gltf", "obj", "ply", "stl"]);
const fontExtensions = new Set(["otf", "ttf", "woff", "woff2"]);
const systemExtensions = new Set(["app", "bin", "dat", "dll", "dylib", "exe", "pkg", "so"]);
const textExtensions = new Set([...codeExtensions, ...tabularTextExtensions, ...textDocumentExtensions]);

/**
 * Files whose type lives in the name rather than an extension. Without these, an
 * everyday repository is mostly ACCESS DENIED screens: Makefile, LICENSE and every
 * dotfile fall through `extensionOf` with nothing to classify.
 */
const namedFiles = new Map<string, FileCategory>([
  ...[
    "brewfile", "buck", "cargo.lock", "composer.lock", "containerfile", "dockerfile", "flake.lock", "gemfile", "gemfile.lock", "go.mod", "go.sum", "gradlew", "jenkinsfile", "justfile", "makefile", "meson.build", "mvnw", "pipfile", "pipfile.lock", "podfile", "poetry.lock", "procfile", "rakefile", "vagrantfile", "workspace", "yarn.lock",
  ].map((name) => [name, "code"] as const),
  ...[
    ".babelrc", ".browserslistrc", ".commitlintrc", ".dockerignore", ".editorconfig", ".env", ".envrc", ".eslintignore", ".eslintrc", ".gitattributes", ".gitignore", ".gitkeep", ".gitmodules", ".htaccess", ".lintstagedrc", ".mailmap", ".node-version", ".npmignore", ".npmrc", ".nvmrc", ".prettierignore", ".prettierrc", ".python-version", ".ruby-version", ".stylelintignore", ".stylelintrc", ".swcrc", ".tool-versions", ".watchmanconfig", ".yarnrc",
  ].map((name) => [name, "code"] as const),
  ...["authors", "changelog", "changes", "codeowners", "contributing", "contributors", "copying", "install", "license", "licence", "news", "notice", "readme", "security", "todo", "version"].map((name) => [name, "document"] as const),
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The MIME type to hand a `Blob`/`File` constructor for this name, or a safe generic fallback. */
export function mimeTypeFor(name: string): string {
  return extensionMimeTypes.get(extensionOf(name)) ?? "application/octet-stream";
}

/** Exposed only so tests can assert every classified media extension also has a MIME entry; not for feature code. */
export const mediaExtensionSets = { image: imageExtensions, audio: audioExtensions, video: videoExtensions } as const;

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
  const named = namedCategory(node.name);
  return textExtensions.has(extension) || named === "code" || named === "document";
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

export function pathFor(node: FsNode, ancestry: FsNode[]): string {
  const index = ancestry.findIndex((ancestor) => ancestor.id === node.parentId);
  const base = index >= 0 ? ancestry.slice(0, index + 1).map((part) => part.name) : ancestry.map((part) => part.name);
  return `/${[...base, node.name].join("/")}`;
}
