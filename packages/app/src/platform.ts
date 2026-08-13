import type { DirectoryPeek, FilesystemRoot, FsNode } from "@fsn/core";
import type { DemoResourceFactory } from "./demo";
import type { ViewerIO } from "./viewer";

export type DirectoryPickResult =
  | { status: "selected"; filesystem: FilesystemRoot }
  | { status: "cancelled" }
  | { status: "snapshot-required" };

export type RecalledSource =
  | { mode: "none" | "demo" }
  | { mode: "filesystem"; filesystem: FilesystemRoot; announcement?: string }
  | { mode: "reopen"; name: string; reopen: () => Promise<FilesystemRoot> }
  | { mode: "missing"; message: string };

/**
 * Every capability that differs between the browser and Tauri shells.
 *
 * Platform objects and native paths remain behind this port; the shared navigator only
 * works with core nodes and opaque resource identifiers.
 */
export type NavigatorPlatform = {
  demoResources: DemoResourceFactory;
  viewer: ViewerIO;
  pickDirectory(): Promise<DirectoryPickResult>;
  importSnapshot?(files: FileList): FilesystemRoot | null;
  ensureChildren(node: FsNode): Promise<FsNode[]>;
  peekChildren(node: FsNode): Promise<DirectoryPeek>;
  /** Releases adapter-owned resources from the source being replaced. */
  disposeFilesystem?(filesystem: FilesystemRoot): void | Promise<void>;
  rememberDemo(): Promise<void>;
  rememberFilesystem(filesystem: FilesystemRoot): Promise<void>;
  recallSource(): Promise<RecalledSource>;
  forgetSource(): Promise<void>;
};
