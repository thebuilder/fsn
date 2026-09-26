import type { DirectoryPeek, DirectoryUsage, FilesystemRoot, FsNode, GitStatusReport } from "@fsn/core";
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
  /**
   * Totals everything beneath a directory for the disk-usage lens. It is a walk of the
   * whole subtree, so it must run without holding the frame, stop when `signal` aborts,
   * and give up at a cap of its own with `complete: false` rather than run unbounded.
   * Optional: without it, the navigator can only total trees already held in memory.
   */
  measureDirectory?(node: FsNode, signal: AbortSignal, onProgress?: (usage: DirectoryUsage) => void): Promise<DirectoryUsage>;
  /**
   * The git status of the open folder, or null when it is not inside a work tree. Only a
   * platform that can read a repository without running anything it configures offers it.
   */
  gitStatus?(filesystem: FilesystemRoot): Promise<GitStatusReport | null>;
  /** Releases adapter-owned resources from the source being replaced. */
  disposeFilesystem?(filesystem: FilesystemRoot): void | Promise<void>;
  rememberDemo(): Promise<void>;
  rememberFilesystem(filesystem: FilesystemRoot): Promise<void>;
  recallSource(): Promise<RecalledSource>;
  forgetSource(): Promise<void>;
};
