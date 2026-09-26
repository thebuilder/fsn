/**
 * Recovers a page left open across a deploy.
 *
 * Every viewer, and the demo's generated files, load as their own chunks, named by a
 * hash of what they contain and what they import. A deploy that touches almost anything
 * renames most of them, and the old names stop existing. A page loaded before the deploy
 * still asks for the old names the first time someone opens a file, gets nothing, and the
 * viewer reports a read failure for a file that is perfectly fine: Safari words it as
 * "Importing a module script failed."
 *
 * Vite announces the failed import as `vite:preloadError`. Reloading picks up the new
 * build, and because the address already carries the directory, the selected object and
 * whether its window was open, the reload lands on the same file with its viewer showing.
 *
 * The guard keeps a chunk that is broken in the new build too from reloading forever:
 * one reload per window, then the error is left on screen where it can be seen.
 */
const RELOADED_AT_KEY = "fsn:stale-build-reload";
export const RELOAD_GUARD_MS = 30_000;

export function shouldReload(now: number, lastReloadAt: number | null): boolean {
  return lastReloadAt === null || now - lastReloadAt > RELOAD_GUARD_MS;
}

export function recoverFromStaleBuilds(target: Window = window): void {
  target.addEventListener("vite:preloadError", () => {
    try {
      const stored = Number(target.sessionStorage.getItem(RELOADED_AT_KEY));
      const lastReloadAt = Number.isFinite(stored) && stored > 0 ? stored : null;
      const now = Date.now();
      if (!shouldReload(now, lastReloadAt)) return;
      target.sessionStorage.setItem(RELOADED_AT_KEY, String(now));
    } catch {
      // Without storage there is no way to tell a first failure from a loop, so the
      // error stays on screen rather than risking a page that reloads itself forever.
      return;
    }
    target.location.reload();
  });
}
