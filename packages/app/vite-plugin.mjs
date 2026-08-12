import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const shellPlaceholder = "<!-- FSN_NAVIGATOR_SHELL -->";
const shellPath = fileURLToPath(new URL("./shell.html", import.meta.url));

function loadShell() {
  return readFileSync(shellPath, "utf8").trim();
}

/**
 * Inject the package-owned navigator markup while leaving each app in charge of
 * its document head and entry module.
 */
export function sharedNavigatorShell() {
  return {
    name: "fsn-shared-navigator-shell",
    configureServer(server) {
      server.watcher.add(shellPath);
    },
    handleHotUpdate(context) {
      if (context.file !== shellPath) return;
      context.server.ws.send({ type: "full-reload", path: "*" });
      return [];
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const placeholderCount = html.split(shellPlaceholder).length - 1;
        if (placeholderCount !== 1) {
          throw new Error(
            `Expected exactly one ${shellPlaceholder} placeholder, found ${placeholderCount}.`,
          );
        }

        return html.replace(shellPlaceholder, loadShell());
      },
    },
  };
}
