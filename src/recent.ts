/**
 * Remembers what was open last, so a reload lands back there instead of on the
 * welcome screen. Only a first visit, or a restore that fails, still asks.
 *
 * For a local folder what is stored is the handle itself, not a path. A
 * `FileSystemDirectoryHandle` survives structured cloning, which is why this uses
 * IndexedDB: `localStorage` takes only strings, and a path string would be
 * worthless anyway, since the browser grants access to handles rather than to
 * locations on disk.
 *
 * Storing a handle is not the same as keeping permission. The reference stays
 * valid across visits, but the grant behind it may lapse back to a prompt, so
 * every restore has to ask `directoryPermission` what it is still allowed to do.
 */

const DATABASE_NAME = "fsn-recent";
const STORE_NAME = "handles";
const SOURCE_KEY = "last-source";

/** The demo needs nothing stored beyond the fact that it was the last choice. */
export type LastSource = { mode: "demo" } | { mode: "local"; handle: FileSystemDirectoryHandle };

/** Chromium's permission methods on handles; absent everywhere else, hence optional. */
type PermissionCapableHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

/**
 * Resolves null rather than throwing whenever the store is unavailable — private
 * windows and storage-blocking settings both refuse to open a database, and a
 * missing convenience is not worth failing a page load over.
 */
async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const opening = indexedDB.open(DATABASE_NAME, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME);
    };
    return await request(opening);
  } catch {
    return null;
  }
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    return await run(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
  } catch {
    // A browser that cannot clone handles simply never remembers one.
    return null;
  } finally {
    database.close();
  }
}

export async function rememberSource(source: LastSource): Promise<void> {
  await withStore("readwrite", (store) => request(store.put(source, SOURCE_KEY)));
}

export async function recallSource(): Promise<LastSource | null> {
  const stored = (await withStore("readonly", (store) => request(store.get(SOURCE_KEY)))) as LastSource | undefined;
  if (stored?.mode === "demo") return stored;
  // Nothing but a genuine handle will do: the permission checks trust whatever comes
  // back from here, and a look-alike object would sail straight past them.
  if (stored?.mode !== "local") return null;
  if (typeof FileSystemDirectoryHandle === "undefined" || !(stored.handle instanceof FileSystemDirectoryHandle)) return null;
  return stored;
}

export async function forgetSource(): Promise<void> {
  await withStore("readwrite", (store) => request(store.delete(SOURCE_KEY)));
}

/**
 * Reports what the page may currently do with a remembered handle.
 *
 * With `request` set this may show the browser's own confirmation, so it must be
 * called from a user gesture; it answers "granted" without prompting when the
 * grant is still live. Reading is deliberately optimistic where the methods are
 * missing entirely: a browser that ships handles without them has no gate to
 * check, and an actual read will report the truth soon enough.
 */
export async function directoryPermission(
  handle: FileSystemDirectoryHandle,
  options: { request: boolean },
): Promise<PermissionState> {
  const gated = handle as PermissionCapableHandle;
  const ask = options.request ? gated.requestPermission : gated.queryPermission;
  if (!ask) return options.request ? "granted" : "prompt";
  try {
    return await ask.call(handle, { mode: "read" });
  } catch {
    return "denied";
  }
}
