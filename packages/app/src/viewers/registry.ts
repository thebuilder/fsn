import { canReadAsText, categoryOf, extensionOf, hasBytes, type FsNode } from "@fsn/core";
import { rendererIds, type Renderer, type RendererId } from "./types";

export type RendererEntry = {
  id: RendererId;
  load: () => Promise<{ render: Renderer }>;
};

type ClassifiedRendererId = Exclude<RendererId, "hex" | "denied">;
type MatchEntry = { id: ClassifiedRendererId; matches: (node: FsNode) => boolean };

const has = (node: FsNode, ...extensions: string[]): boolean => extensions.includes(extensionOf(node.name));

/** Dynamic loaders keep every format in its own chunk and form the RendererId source of truth. */
const loaders = {
  image: () => import("./image"),
  model: () => import("./model"),
  font: () => import("./font"),
  table: () => import("./table"),
  json: () => import("./json"),
  text: () => import("./text"),
  media: () => import("./media"),
  pdf: () => import("./pdf"),
  archive: () => import("./archive"),
  hex: () => import("./hex"),
  denied: () => import("./denied"),
} satisfies Record<RendererId, () => Promise<{ render: Renderer }>>;

/** First match wins, so structured readers sit ahead of the generic text reader. */
const matchers: MatchEntry[] = [
  { id: "image", matches: (node) => categoryOf(node) === "image" },
  { id: "model", matches: (node) => categoryOf(node) === "model" },
  { id: "font", matches: (node) => categoryOf(node) === "font" },
  { id: "table", matches: (node) => has(node, "csv", "tsv") },
  { id: "json", matches: (node) => has(node, "avsc", "geojson", "har", "ipynb", "json", "webmanifest") },
  { id: "text", matches: canReadAsText },
  { id: "media", matches: (node) => ["audio", "video"].includes(categoryOf(node)) },
  { id: "pdf", matches: (node) => has(node, "pdf") },
  { id: "archive", matches: (node) => has(node, "zip", "jar") },
];

if (rendererIds.some((id) => !(id in loaders))) throw new Error("Renderer loader registry is incomplete.");

export function rendererFor(node: FsNode): RendererEntry {
  // Nothing to decode beats every other rule: demo objects carry metadata only.
  if (!hasBytes(node)) return rendererById("denied");
  return rendererById(matchers.find((entry) => entry.matches(node))?.id ?? "denied");
}

export function rendererById(id: RendererId): RendererEntry {
  return { id, load: loaders[id] };
}
