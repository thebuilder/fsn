import { canReadAsText, categoryOf, extensionOf, hasBytes, type FsNode } from "../filesystem";
import type { Renderer, RendererId } from "./types";

type Entry = {
  id: RendererId;
  matches: (node: FsNode) => boolean;
  /**
   * Dynamic so each viewer becomes its own chunk: opening a text file never pays for
   * the 3D loaders, and the model viewer's `three` import resolves to the chunk the
   * world already loaded.
   */
  load: () => Promise<{ render: Renderer }>;
};

const has = (node: FsNode, ...extensions: string[]): boolean => extensions.includes(extensionOf(node.name));

/** First match wins, so the structured readers sit ahead of the generic text reader. */
const registry: Entry[] = [
  { id: "image", matches: (node) => categoryOf(node) === "image", load: () => import("./image") },
  { id: "model", matches: (node) => categoryOf(node) === "model", load: () => import("./model") },
  { id: "font", matches: (node) => categoryOf(node) === "font", load: () => import("./font") },
  { id: "table", matches: (node) => has(node, "csv", "tsv"), load: () => import("./table") },
  { id: "json", matches: (node) => has(node, "json", "geojson", "webmanifest"), load: () => import("./json") },
  { id: "text", matches: canReadAsText, load: () => import("./text") },
  { id: "media", matches: (node) => ["audio", "video"].includes(categoryOf(node)), load: () => import("./media") },
  { id: "pdf", matches: (node) => has(node, "pdf"), load: () => import("./pdf") },
  { id: "archive", matches: (node) => has(node, "zip", "jar"), load: () => import("./archive") },
  { id: "hex", matches: () => false, load: () => import("./hex") },
  { id: "denied", matches: () => true, load: () => import("./denied") },
];

const byId = new Map(registry.map((entry) => [entry.id, entry]));

export function rendererFor(node: FsNode): Entry {
  // Nothing to decode beats every other rule: demo objects carry metadata only.
  if (!hasBytes(node)) return byId.get("denied")!;
  return registry.find((entry) => entry.matches(node)) ?? byId.get("denied")!;
}

export function rendererById(id: RendererId): Entry {
  return byId.get(id) ?? byId.get("denied")!;
}
