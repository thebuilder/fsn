import { inject } from "@vercel/analytics";
import { mountNavigator, type NavigatorPlatform } from "@fsn/app";
import {
  browserResourceUrl,
  directoryHandleFor,
  disposeBrowserFilesystem,
  ensureChildren,
  openBrowserDirectory,
  peekChildren,
  readBrowserResource,
  registerBrowserTextResource,
  registerBrowserUrlResource,
  rootFromDirectoryHandle,
  rootFromFileList,
} from "./filesystem";
import { directoryPermission, forgetSource, recallSource, rememberSource } from "./recent";

inject({ mode: import.meta.env.PROD ? "production" : "development" });

const platform: NavigatorPlatform = {
  demoResources: {
    text: registerBrowserTextResource,
    url: registerBrowserUrlResource,
  },
  viewer: {
    read: readBrowserResource,
    directUrl: browserResourceUrl,
    openExternalUrl: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  },
  pickDirectory: async () => {
    const filesystem = await openBrowserDirectory();
    return filesystem ? { status: "selected", filesystem } : { status: "snapshot-required" };
  },
  importSnapshot: rootFromFileList,
  ensureChildren,
  peekChildren,
  disposeFilesystem: disposeBrowserFilesystem,
  rememberDemo: async () => rememberSource({ mode: "demo" }),
  rememberFilesystem: async (filesystem) => {
    const handle = directoryHandleFor(filesystem.root);
    if (handle) await rememberSource({ mode: "local", handle });
  },
  recallSource: async () => {
    const last = await recallSource();
    if (!last) return { mode: "none" };
    if (last.mode === "demo") return last;

    const permission = await directoryPermission(last.handle, { request: false });
    if (permission !== "granted") {
      return {
        mode: "reopen",
        name: last.handle.name,
        reopen: async () => {
          if (await directoryPermission(last.handle, { request: true }) !== "granted") {
            throw new Error(`Access to ${last.handle.name} was denied`);
          }
          return rootFromDirectoryHandle(last.handle);
        },
      };
    }

    try {
      return { mode: "filesystem", filesystem: await rootFromDirectoryHandle(last.handle) };
    } catch {
      await forgetSource();
      return { mode: "missing", message: `Could not reopen ${last.handle.name} — it may have been moved or renamed` };
    }
  },
  forgetSource,
};

mountNavigator(platform);
