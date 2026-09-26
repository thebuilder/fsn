import { formatBytes, type FsNode } from "./filesystem";

/**
 * What a directory holds all the way down, as far as a measurement could see. A folder's
 * own listing only says what is directly inside it; this is the answer to where the space
 * actually went.
 */
export type DirectoryUsage = {
  /** Apparent size of every file beneath the directory. */
  bytes: number;
  files: number;
  directories: number;
  /** Latest modification time among the files counted, when any reported one. */
  newest?: number;
  /**
   * False when the walk stopped short — an entry cap, or a directory it was not allowed
   * to read — so every number above is a lower bound rather than the total.
   */
  complete: boolean;
};

/** One entry of a directory listing, as a measurement needs to see it. */
export type MeasuredEntry<D> =
  | { kind: "file"; size?: number; modified?: number }
  | { kind: "directory"; directory: D };

export type MeasureOptions = {
  signal?: AbortSignal;
  /** How many directories are listed at once. */
  concurrency: number;
  /** Entries visited before the walk gives up and reports a lower bound. */
  entryLimit: number;
  /** Called after each directory lands, with the running totals so far. */
  onProgress?: (usage: DirectoryUsage) => void;
};

/**
 * Totals a tree through whatever `list` reads, a few directories at a time.
 *
 * Every platform has its own way to list a folder and its own cost for doing it, so the
 * walk itself lives here and only the reading is handed in: the browser lists through
 * directory handles, and anything already in memory can list from its nodes. Breadth
 * first, so a walk that hits its cap has at least seen the shallow parts of every branch
 * rather than all of one deep one. A directory that cannot be listed is skipped and
 * marks the result incomplete; cancelling rejects with the signal's reason.
 */
export function measureTree<D>(
  root: D,
  list: (directory: D, signal?: AbortSignal) => Promise<MeasuredEntry<D>[]>,
  options: MeasureOptions,
): Promise<DirectoryUsage> {
  const { signal } = options;
  const usage: DirectoryUsage = { bytes: 0, files: 0, directories: 0, complete: true };
  const queue: D[] = [root];
  const concurrency = Math.max(1, options.concurrency);
  let head = 0;
  let visited = 0;
  let running = 0;
  let stopped = false;

  const absorb = (entries: MeasuredEntry<D>[]): void => {
    for (const entry of entries) {
      visited += 1;
      if (visited > options.entryLimit) {
        usage.complete = false;
        stopped = true;
        return;
      }
      if (entry.kind === "directory") {
        usage.directories += 1;
        queue.push(entry.directory);
        continue;
      }
      usage.files += 1;
      // A file whose size could not be read still counts as a file; the byte total
      // just stops claiming to be exact.
      if (entry.size !== undefined) usage.bytes += entry.size;
      else usage.complete = false;
      if (entry.modified !== undefined) usage.newest = Math.max(usage.newest ?? entry.modified, entry.modified);
    }
  };

  return new Promise<DirectoryUsage>((resolve, reject) => {
    let settled = false;
    const pump = (): void => {
      if (settled) return;
      if (signal?.aborted) {
        settled = true;
        reject(signal.reason);
        return;
      }
      // Starting a listing only ever happens here, so a directory found by one worker is
      // picked up by whichever slot frees next rather than waiting behind a poll.
      while (!stopped && running < concurrency && head < queue.length) {
        const directory = queue[head];
        head += 1;
        running += 1;
        list(directory, signal).then(
          (entries) => {
            if (!signal?.aborted) {
              absorb(entries);
              options.onProgress?.({ ...usage });
            }
          },
          () => {
            usage.complete = false;
          },
        ).finally(() => {
          running -= 1;
          pump();
        });
      }
      if (running === 0 && (stopped || head >= queue.length)) {
        settled = true;
        resolve(usage);
      }
    };
    pump();
  });
}

/**
 * Totals a tree that is already in memory — the demo, or a folder imported as a
 * snapshot — without any I/O. A directory whose children were never read cannot be
 * counted, so meeting one marks the result as a lower bound.
 */
export function usageOfLoadedTree(root: FsNode, entryLimit = Number.POSITIVE_INFINITY): DirectoryUsage {
  const usage: DirectoryUsage = { bytes: 0, files: 0, directories: 0, complete: Boolean(root.children) };
  const queue: FsNode[] = [root];
  let head = 0;
  let visited = 0;
  while (head < queue.length) {
    const directory = queue[head];
    head += 1;
    for (const node of directory.children ?? []) {
      visited += 1;
      if (visited > entryLimit) {
        usage.complete = false;
        return usage;
      }
      if (node.kind === "directory") {
        usage.directories += 1;
        if (node.children) queue.push(node);
        else usage.complete = false;
        continue;
      }
      usage.files += 1;
      usage.bytes += node.size ?? 0;
      if (node.modified !== undefined) usage.newest = Math.max(usage.newest ?? node.modified, node.modified);
    }
  }
  return usage;
}

/**
 * Folds a directory's own files and its measured subdirectories into its total, which
 * is how the directory you are standing in gets a total without walking it twice. Any
 * subdirectory still unmeasured leaves the sum a lower bound.
 */
export function combineUsage(children: FsNode[]): DirectoryUsage {
  const usage: DirectoryUsage = { bytes: 0, files: 0, directories: 0, complete: true };
  for (const node of children) {
    if (node.kind === "directory") {
      usage.directories += 1;
      const inner = node.usage;
      if (!inner) {
        usage.complete = false;
        continue;
      }
      usage.bytes += inner.bytes;
      usage.files += inner.files;
      usage.directories += inner.directories;
      if (!inner.complete) usage.complete = false;
      if (inner.newest !== undefined) usage.newest = Math.max(usage.newest ?? inner.newest, inner.newest);
      continue;
    }
    usage.files += 1;
    usage.bytes += node.size ?? 0;
    if (node.modified !== undefined) usage.newest = Math.max(usage.newest ?? node.modified, node.modified);
  }
  return usage;
}

/** `4.2 GB`, or `≥ 4.2 GB` when the walk stopped before it saw everything. */
export function formatUsageBytes(usage: DirectoryUsage): string {
  return `${usage.complete ? "" : "≥ "}${formatBytes(usage.bytes)}`;
}

/** The one-line summary a panel shows: size, then how many files it is spread across. */
export function formatUsage(usage: DirectoryUsage): string {
  const files = `${usage.complete ? "" : "≥ "}${usage.files.toLocaleString("en-US")} ${usage.files === 1 ? "file" : "files"}`;
  return `${formatUsageBytes(usage)} · ${files}`;
}
