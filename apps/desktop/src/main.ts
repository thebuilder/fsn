import { mountNavigator, type DemoResourceFactory, type NavigatorPlatform } from "@fsn/app";
import { canReadAsText, categoryOf, type FsResource } from "@fsn/core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  clearDesktopRoot,
  ensureChildren,
  openDesktopDirectory,
  openDesktopNative,
  peekChildren,
  readDesktopResource,
  type DesktopFileSnapshot,
  writeDesktopText,
} from "./filesystem";

type DemoResource = { kind: "text"; content: string } | { kind: "url"; url: string };
const demoResources = new Map<string, DemoResource>();
const DESKTOP_MODE_KEY = "fsn.desktop.last-mode";
const UNSAFE_NATIVE_EXTENSIONS = new Set([
  "app", "bat", "bin", "cmd", "com", "command", "cpl", "dat", "desktop", "dll", "dylib",
  "exe", "hta", "lnk", "msi", "pkg", "ps1", "reg", "scr", "sh", "so", "vbs",
]);
const writeSnapshots = new Map<string, DesktopFileSnapshot>();
const conflictSnapshots = new Map<string, DesktopFileSnapshot>();

const registerDemo = (id: string, resource: DemoResource): FsResource => {
  demoResources.set(id, resource);
  return { id, readable: true };
};

const demoFactory: DemoResourceFactory = {
  text: (id, content) => registerDemo(id, { kind: "text", content }),
  url: (id, url) => registerDemo(id, { kind: "url", url }),
};

const platform: NavigatorPlatform = {
  demoResources: demoFactory,
  viewer: {
    read: async (node, signal) => {
      const demo = node.resource ? demoResources.get(node.resource.id) : undefined;
      if (demo?.kind === "text") return new Blob([demo.content], { type: "text/plain" });
      if (demo?.kind === "url") {
        const response = await fetch(demo.url, { signal });
        if (!response.ok) throw new Error(`Demo object unavailable (HTTP ${response.status}).`);
        return response.blob();
      }
      const loaded = await readDesktopResource(node, signal);
      if (loaded.snapshot) {
        writeSnapshots.set(node.resource!.id, loaded.snapshot);
        conflictSnapshots.delete(node.resource!.id);
      }
      return loaded.blob;
    },
    directUrl: (node) => {
      const demo = node.resource ? demoResources.get(node.resource.id) : undefined;
      return demo?.kind === "url" ? demo.url : null;
    },
    canOpenNative: (node) => Boolean(
      node.resource?.readable
      && !demoResources.has(node.resource.id)
      && categoryOf(node) !== "system"
      && !UNSAFE_NATIVE_EXTENSIONS.has(node.name.split(".").pop()?.toLowerCase() ?? "")
    ),
    openNative: async (node) => {
      if (node.resource && demoResources.has(node.resource.id)) {
        throw new Error("Demo objects do not have a native application.");
      }
      await openDesktopNative(node);
    },
    canWriteText: (node) => Boolean(
      node.resource?.readable
      && !demoResources.has(node.resource.id)
      && canReadAsText(node)
    ),
    writeText: async (node, value, options) => {
      if (node.resource && demoResources.has(node.resource.id)) {
        throw new Error("Demo objects are read-only.");
      }
      const id = node.resource!.id;
      let expected: DesktopFileSnapshot | undefined;
      if (options?.force) {
        expected = conflictSnapshots.get(id);
        if (!expected) {
          throw new Error("The changed file must be checked again before retrying the save.");
        }
      } else {
        expected = writeSnapshots.get(id);
      }
      if (!expected) {
        throw new Error("Reopen this file before saving so FSN can verify its original revision.");
      }
      const result = await writeDesktopText(node, value, expected);
      if (result.status === "conflict") {
        conflictSnapshots.set(id, result.actual);
        return { status: "conflict" };
      }
      conflictSnapshots.delete(id);
      writeSnapshots.set(id, result.snapshot);
      return {
        status: "saved",
        size: result.snapshot.size,
        modified: result.snapshot.modified,
      };
    },
  },
  pickDirectory: async () => {
    const filesystem = await openDesktopDirectory();
    if (filesystem) {
      writeSnapshots.clear();
      conflictSnapshots.clear();
    }
    return filesystem ? { status: "selected", filesystem } : { status: "cancelled" };
  },
  ensureChildren,
  peekChildren,
  rememberDemo: async () => {
    await clearDesktopRoot();
    writeSnapshots.clear();
    conflictSnapshots.clear();
    storeDesktopMode("demo");
  },
  rememberFilesystem: async (filesystem) => {
    void filesystem;
    storeDesktopMode("filesystem");
  },
  recallSource: async () => {
    if (readDesktopMode() === "demo") {
      await clearDesktopRoot();
      return { mode: "demo" };
    }
    // Native folder grants are deliberately session-only; stale webview paths
    // must never become authorization after a relaunch.
    if (readDesktopMode() === "filesystem") {
      await clearDesktopRoot();
      writeSnapshots.clear();
      conflictSnapshots.clear();
      storeDesktopMode(null);
    }
    await clearDesktopRoot();
    return { mode: "none" };
  },
  forgetSource: async () => {
    await clearDesktopRoot();
    writeSnapshots.clear();
    conflictSnapshots.clear();
    storeDesktopMode(null);
  },
};

const welcomeCopy = document.querySelector<HTMLElement>(".welcome-copy > p:not(.eyebrow)");
if (welcomeCopy) welcomeCopy.textContent = "Fly through a generated file system now, or open a folder on this device. Files stay local, and edits happen only when you press Save.";
const welcomePrivacy = document.getElementById("welcome-privacy");
if (welcomePrivacy) welcomePrivacy.textContent = "Local access. Changes are written only when you press Save.";
const viewerChannel = document.getElementById("viewer-channel");
if (viewerChannel) viewerChannel.replaceChildren(Object.assign(document.createElement("i"), { className: "viewer-led" }), " LOCAL DESKTOP CHANNEL");

const navigator = mountNavigator(platform);

if (isTauri()) {
  void installNativeLifecycle();
}

async function installNativeLifecycle(): Promise<void> {
  const unlistenQuit = await listen<{ requestId: number }>("fsn://quit-requested", (event) => {
    void invoke("respond_to_macos_quit", {
      requestId: event.payload.requestId,
      confirmed: navigator.requestClose(),
    });
  });
  const unlistenClose = await getCurrentWindow().onCloseRequested((event) => {
    if (!navigator.requestClose()) event.preventDefault();
  });
  await invoke("macos_quit_bridge_ready");
  import.meta.hot?.dispose(() => {
    unlistenQuit();
    unlistenClose();
  });
}

function storeDesktopMode(mode: "demo" | "filesystem" | null): void {
  try {
    if (mode) localStorage.setItem(DESKTOP_MODE_KEY, mode);
    else localStorage.removeItem(DESKTOP_MODE_KEY);
  } catch {
    // A remembered location is optional; the current session remains fully usable.
  }
}

function readDesktopMode(): "demo" | "filesystem" | null {
  try {
    const mode = localStorage.getItem(DESKTOP_MODE_KEY);
    return mode === "demo" || mode === "filesystem" ? mode : null;
  } catch {
    return null;
  }
}
