import { indexChildren, type FsNode, type IndexedObject } from "@fsn/core";

export type TreeIndexStatus = "indexing" | "complete" | "capped" | "cancelled";

export type TreeIndexOptions = {
  /** Reads a directory's children, caching them on the node; the platform's `ensureChildren`. */
  read(node: FsNode): Promise<FsNode[]>;
  /** Aborted when the source this index belongs to is replaced. */
  signal: AbortSignal;
  /** The index stops growing here; everything past it is simply not searchable. */
  limit: number;
  /** How many directory reads may be in flight at once. */
  concurrency: number;
  /** Called whenever the walk has handed the frame back, and once when it stops. */
  onProgress?(): void;
  /** How long the walk may hold the thread before yielding, in milliseconds. */
  sliceMs?: number;
  /** Hands the thread back to the page. A macrotask by default, so a frame can land. */
  yieldToPage?: () => Promise<void>;
};

/**
 * Every object in a mounted source, gathered in the background so search can find what
 * is not on screen.
 *
 * The walk goes through the same `read` the navigator uses to open a directory, so each
 * listing it collects is one the world never has to read again, and a directory the
 * visitor opens while the index is still running shares the read already in flight
 * instead of racing it. It is breadth-first, so shallow objects — the likeliest to be
 * wanted — are searchable first, and partial results are useful from the first yield.
 *
 * Three things keep it from being felt. Reads run a few at a time, so one slow handle
 * stalls a slot rather than the walk. It hands the thread back whenever it has held it
 * for a slice, which matters most for an in-memory source: there every read resolves as
 * a microtask, and a walk that never yields would finish the whole tree before the next
 * frame. And it stops at a cap, because a home directory can hold millions of entries
 * and an index of all of them would cost more memory than search is worth.
 */
export class TreeIndex {
  readonly entries: IndexedObject[] = [];
  status: TreeIndexStatus = "indexing";
  /** Directories that could not be listed (denied, vanished), whose contents are missing. */
  unreadable = 0;
  /** Resolves when the walk stops, for whatever reason; never rejects. */
  readonly done: Promise<void>;

  private readonly queue: FsNode[][];
  private head = 0;
  private active = 0;
  private sliceStart = 0;
  private yielding: Promise<void> | null = null;

  constructor(
    readonly root: FsNode,
    private readonly options: TreeIndexOptions,
  ) {
    this.queue = [[root]];
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.sliceStart = now();
    this.pump();
  }

  private finish: () => void = () => {};

  private get stopped(): boolean {
    return this.status !== "indexing";
  }

  /** Starts as many reads as the concurrency allows, and settles the walk once none are left. */
  private pump(): void {
    if (!this.stopped && this.options.signal.aborted) this.status = "cancelled";
    while (!this.stopped && this.active < this.options.concurrency && this.head < this.queue.length) {
      const trail = this.queue[this.head];
      this.head += 1;
      this.active += 1;
      void this.visit(trail).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
    if (this.active > 0) return;
    if (!this.stopped) this.status = "complete";
    // The queue can hold a great many trails by the end; none of them are needed now.
    this.queue.length = 0;
    this.options.onProgress?.();
    this.finish();
  }

  private async visit(trail: FsNode[]): Promise<void> {
    const directory = trail[trail.length - 1];
    let children: FsNode[];
    try {
      children = await this.options.read(directory);
    } catch {
      this.unreadable += 1;
      return;
    }
    await this.yieldIfSliceSpent();
    if (this.stopped || this.options.signal.aborted) return;

    const room = this.options.limit - this.entries.length;
    const admitted = children.length > room ? children.slice(0, room) : children;
    this.entries.push(...indexChildren(trail, admitted));
    for (const child of admitted) {
      if (child.kind === "directory") this.queue.push([...trail, child]);
    }
    if (admitted.length < children.length || this.entries.length >= this.options.limit) this.status = "capped";
  }

  /**
   * Every in-flight visit waits on the same yield, so a slice ends once for the whole
   * pool rather than once per worker, and progress is reported at the moment the page
   * gets its thread back — which is also the only moment anyone could see it.
   */
  private async yieldIfSliceSpent(): Promise<void> {
    if (this.yielding) {
      await this.yielding;
      return;
    }
    if (now() - this.sliceStart < (this.options.sliceMs ?? 8)) return;
    this.yielding = (async () => {
      this.options.onProgress?.();
      await (this.options.yieldToPage ?? nextMacrotask)();
      this.sliceStart = now();
      this.yielding = null;
    })();
    await this.yielding;
  }
}

function now(): number {
  return performance.now();
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
