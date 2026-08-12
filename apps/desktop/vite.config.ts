import { defineConfig } from "vite";
import { sharedNavigatorShell } from "../../packages/app/vite-plugin.mjs";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  plugins: [sharedNavigatorShell()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
