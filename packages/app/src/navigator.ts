import {
  categoryOf,
  formatBytes,
  formatDate,
  indexChildren,
  locationOf,
  pathFor,
  searchIndex,
  sortNodes,
  type FilesystemRoot,
  type FsNode,
  type IndexedObject,
} from "@fsn/core";
import { createDemoFilesystem } from "./demo";
import { LatestSourceTransition } from "./filesystem-transition";
import { dismissOnOutsidePress } from "./light-dismiss";
import type { NavigatorPlatform, RecalledSource } from "./platform";
import { readRoute, routeFor, sameObject, sameRoute, type Route, type RouteObject } from "./route";
import { WorldScene, type NavigationDirection } from "./scene";
import { TreeIndex } from "./tree-index";
import { FileViewer } from "./viewer";
import { el } from "./viewers/dom";

export type NavigatorHandle = {
  /** Returns false when an active editor refuses to discard its unsaved changes. */
  requestClose(): boolean;
  /** Tears down listeners, rendering resources and the active filesystem. Idempotent. */
  destroy(): Promise<void>;
};

export function mountNavigator(platform: NavigatorPlatform): NavigatorHandle {
const lifecycle = new AbortController();
const listener = { signal: lifecycle.signal };

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
}

const canvas = getElement<HTMLCanvasElement>("world");
const breadcrumbs = getElement<HTMLElement>("breadcrumbs");
const sourceLabel = getElement<HTMLElement>("source-label");
const sceneTitle = getElement<HTMLElement>("scene-title");
const directoryTitle = getElement<HTMLElement>("directory-title");
const directorySummary = getElement<HTMLElement>("directory-summary");
const detailsKind = getElement<HTMLElement>("details-kind");
const detailsTitle = getElement<HTMLElement>("details-title");
const detailsGlyph = getElement<HTMLElement>("details-glyph");
const detailsList = getElement<HTMLElement>("details-list");
const enterButton = getElement<HTMLButtonElement>("enter-button");
const hoverLabel = getElement<HTMLElement>("hover-label");
const reticle = getElement<HTMLElement>("reticle");
const controls = getElement<HTMLElement>("controls");
const status = getElement<HTMLElement>("status");
const folderButton = getElement<HTMLButtonElement>("folder-button");
const folderFallback = getElement<HTMLInputElement>("folder-fallback");
const demoButton = getElement<HTMLButtonElement>("demo-button");
const searchButton = getElement<HTMLButtonElement>("search-button");
const searchDialog = getElement<HTMLDialogElement>("search-dialog");
const searchInput = getElement<HTMLInputElement>("search-input");
const searchResults = getElement<HTMLUListElement>("search-results");
const searchCount = getElement<HTMLElement>("search-count");
const searchProgress = getElement<HTMLElement>("search-progress");
const helpDialog = getElement<HTMLDialogElement>("help-dialog");
const helpButton = getElement<HTMLButtonElement>("help-button");
const welcomeDialog = getElement<HTMLDialogElement>("welcome-dialog");
const welcomeDemo = getElement<HTMLButtonElement>("welcome-demo");
const folderButtonLabel = getElement<HTMLElement>("folder-button-label");
const brandHome = getElement<HTMLAnchorElement>("brand-home");

// The hidden FileList fallback is a browser-only escape hatch. Keeping it focusable
// in the native shell would expose an inert control to keyboard and screen-reader users.
if (!platform.importSnapshot) folderFallback.hidden = true;

const viewerDialog = getElement<HTMLDialogElement>("file-viewer");
const viewer = new FileViewer(
  {
    dialog: viewerDialog,
    titlebar: getElement("viewer-titlebar"),
    title: getElement("viewer-title"),
    mode: getElement("viewer-mode"),
    path: getElement("viewer-path"),
    size: getElement("viewer-size"),
    content: getElement("viewer-content"),
    position: getElement("viewer-position"),
    tools: getElement("viewer-tools"),
    zoom: getElement<HTMLButtonElement>("viewer-zoom"),
    collapse: getElement<HTMLButtonElement>("viewer-collapse"),
    grow: getElement<HTMLButtonElement>("viewer-grow"),
    close: [getElement<HTMLButtonElement>("viewer-close"), getElement<HTMLButtonElement>("viewer-dismiss")],
  },
  platform.viewer,
);

let filesystem: FilesystemRoot = createDemoFilesystem(platform.demoResources);
let ancestry: FsNode[] = [filesystem.root];
let selectedNode: FsNode | null = null;
let destroyPromise: Promise<void> | null = null;
const sourceTransition = new LatestSourceTransition<FilesystemRoot>((source) => platform.disposeFilesystem?.(source));

const world = new WorldScene(canvas, {
  onSelect: updateSelection,
  onOpen: (node) => void openNode(node),
  onHover: updateHover,
  onAim: updateAim,
  onKeyboardNavigation: (active) => reticle.classList.toggle("is-keyboard-active", active),
  onSwapKeys: (swapped) => controls.classList.toggle("is-swapped", swapped),
  onEnterArea: adoptArea,
});

function currentDirectory(): FsNode {
  return ancestry[ancestry.length - 1];
}

function currentChildren(): FsNode[] {
  return sortNodes(currentDirectory().children ?? []);
}

/** Ancestry chains keyed by directory id, so the camera can re-enter a known area. */
const ancestryById = new Map<string, FsNode[]>();
let renderedDirectoryId: string | null = null;

/**
 * What a directory change owes the address bar.
 *
 * `push` is the ordinary case, and the point of the whole arrangement: one directory
 * entered is one entry to come back through. `replace` is for arriving somewhere without
 * having gone anywhere — mounting a source, or correcting an address that named a
 * directory which is no longer there. `keep` is for the changes the address bar caused,
 * which must not be written back as new history, and for the one moment it is holding
 * something more useful than where we are.
 */
type RouteIntent = "push" | "replace" | "keep";

/**
 * The address this page was opened with, held until a source that can answer to it is
 * mounted. That is rarely the first thing drawn: a lapsed folder grant is offered from
 * the toolbar rather than restored, so the directory named here can be one click away.
 */
let pendingRoute: Route = readRoute(window.location.hash);
const noRoute: Route = { names: [], object: null };

function syncRoute(intent: RouteIntent): void {
  if (intent === "keep") return;
  // Going somewhere deliberately answers the opening address, whether or not it was the
  // place asked for. Nothing later is allowed to drag a mounted source back to it.
  if (intent === "push") pendingRoute = noRoute;
  const names = ancestry.map((node) => node.name);
  const object = objectRoute();
  const address = readRoute(window.location.hash);
  if (sameRoute(names, address.names) && sameObject(object, address.object)) return;
  const url = routeFor(names, object);
  if (intent === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

/**
 * The object the address names beside the directory: the one whose window is open, or
 * else the one selected. Only ever one living in the directory addressed — a selection
 * left over from the directory just walked out of names nothing in the new one.
 */
function objectRoute(): RouteObject | null {
  const here = currentDirectory();
  if (heldObject?.directoryId === here.id) return heldObject.object;
  const shown = viewer.shownNode;
  if (shown?.parentId === here.id) return { name: shown.name, viewing: true };
  if (selectedNode?.parentId === here.id) return { name: selectedNode.name, viewing: false };
  return null;
}

/**
 * Keeps the address in step with what is selected and open, without adding history. The
 * directory is the place you went; what you picked out there is a detail of that visit,
 * so it amends the entry rather than stacking one per click, and Back returns to the
 * previous directory with whatever was selected in it when you left.
 *
 * Only an address already naming this directory is amended. One naming somewhere else is
 * either being travelled to right now or held for a source not yet mounted, and in both
 * cases writing it is `syncRoute`'s business, not a click's.
 */
function syncObjectRoute(): void {
  if (lifecycle.signal.aborted) return;
  const names = ancestry.map((node) => node.name);
  const address = readRoute(window.location.hash);
  if (!sameRoute(names, address.names)) return;
  const object = objectRoute();
  if (sameObject(object, address.object)) return;
  window.history.replaceState(null, "", routeFor(names, object));
}

/**
 * An object named by the opening address, waiting for the welcome screen to go. Nothing
 * behind that screen moves, and a window opened over it would be the first thing a new
 * visitor had to close, so the object is held — and kept in the address, so a reload
 * still asks for it — until the screen is gone and the world is in view.
 */
let heldObject: { directoryId: string; object: RouteObject } | null = null;

/**
 * Selects the object an address names in the directory just arrived in, and reopens its
 * window if the address says it was open. A name no longer there is dropped from the
 * address rather than chased: the directory still landed, which is as near as it gets.
 */
function landObject(object: RouteObject | null): void {
  if (!object || lifecycle.signal.aborted) return;
  if (welcomeHold) {
    heldObject = { directoryId: currentDirectory().id, object };
    syncObjectRoute();
    return;
  }
  if (sameObject(objectRoute(), object)) return;
  const node = currentChildren().find((child) => child.name === object.name);
  if (node && selectedNode?.id !== node.id) world.focusNode(node);
  if (node && object.viewing && node.kind === "file") {
    if (viewer.shownNode?.id !== node.id) void openNode(node);
    return;
  }
  if (viewer.shownNode?.parentId === currentDirectory().id) viewer.close();
  syncObjectRoute();
}

/** Updates every panel outside the 3D view. Never touches the camera. */
function renderChrome(): void {
  const current = currentDirectory();
  const children = currentChildren();
  ancestryById.set(current.id, [...ancestry]);
  brandHome.href = routeFor([filesystem.root.name]);
  sourceLabel.textContent = filesystem.sourceLabel;
  directoryTitle.textContent = current.name;
  const directories = children.filter((node) => node.kind === "directory").length;
  const files = children.length - directories;
  directorySummary.textContent = `${children.length} objects · ${directories} ${directories === 1 ? "directory" : "directories"} · ${files} ${files === 1 ? "file" : "files"}`;
  renderBreadcrumbs();
  if (renderedDirectoryId !== current.id) {
    renderedDirectoryId = current.id;
    if (!welcomeHold) restartTitleTransition();
  }
}

/**
 * Nothing behind the welcome screen moves while it is up — not the skyline, not the
 * camera, not the headings that would otherwise have played their entrance to an
 * audience of one blurred backdrop. Everything owed is banked and spent at once.
 */
let welcomeHold = false;

function holdBehindWelcome(): void {
  welcomeHold = true;
  document.documentElement.dataset.welcome = "held";
  world.holdReveal();
}

function releaseBehindWelcome(): void {
  if (!welcomeHold) return;
  welcomeHold = false;
  delete document.documentElement.dataset.welcome;
  world.releaseReveal();
  // Forgetting the trail is what makes every crumb read as new, so the whole path
  // draws itself in rather than appearing already written.
  previousCrumbIds = [];
  renderBreadcrumbs();
  restartTitleTransition();
  const held = heldObject;
  heldObject = null;
  if (held?.directoryId === currentDirectory().id) landObject(held.object);
  else syncObjectRoute();
}

/** Replays the heading animation; the reflow is what lets it retrigger. */
function restartTitleTransition(): void {
  sceneTitle.classList.remove("is-entering");
  void sceneTitle.offsetWidth;
  sceneTitle.classList.add("is-entering");
}

const PENDING_DELAY = 300;
let pendingReads = 0;
let pendingTimer = 0;

function beginPending(): () => void {
  pendingReads += 1;
  if (pendingReads === 1) {
    pendingTimer = window.setTimeout(() => {
      document.documentElement.dataset.busy = "reading";
    }, PENDING_DELAY);
  }
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    pendingReads -= 1;
    if (pendingReads > 0) return;
    window.clearTimeout(pendingTimer);
    delete document.documentElement.dataset.busy;
  };
}

/** Guards against a slow peek from an abandoned directory landing after a newer one. */
let renderGeneration = 0;

async function renderDirectory(
  announce = true,
  direction: NavigationDirection = "backward",
  route: RouteIntent = "push",
): Promise<void> {
  if (lifecycle.signal.aborted) return;
  renderChrome();
  const generation = (renderGeneration += 1);
  const current = currentDirectory();
  const children = currentChildren();

  // Plot size and preview markers come from one level further down, so those listings
  // have to land before the layout is built — otherwise every folder is drawn the same
  // size and the one thing a plot is supposed to tell you is missing. Peeking never
  // opens a file, so this is a readdir per sub-directory, not a metadata sweep.
  const unknown = children.filter((node) => node.kind === "directory" && !node.peek);
  if (unknown.length) {
    const settle = beginPending();
    try {
      await Promise.all(unknown.map((node) => platform.peekChildren(node)));
    } finally {
      settle();
    }
    // The camera may have adopted a different directory while the peeks were in flight,
    // which bumps the generation but can also leave it unchanged if nothing else rendered
    // meanwhile — so the identity check catches what the counter alone might miss.
    if (generation !== renderGeneration || lifecycle.signal.aborted || currentDirectory().id !== current.id) return;
  }

  if (lifecycle.signal.aborted) return;

  // Deferred past every guard above: a render that gets superseded while its peeks are
  // in flight must never write a history entry for a directory it did not end up
  // drawing. adoptArea already wrote its own entry for whatever the camera actually
  // settled on, so an abandoned render reaching this line would otherwise double it.
  syncRoute(route);

  try {
    world.setDirectory(current, children, direction);
  } catch (error) {
    // The chrome (breadcrumbs, address) has already committed to this directory; absorb
    // a layout failure here so the app keeps working instead of leaving the 3D world
    // silently stuck on whatever it drew last.
    setStatus(`The world could not draw ${current.name}: ${error instanceof Error ? error.message : "unknown failure"}`, true);
    return;
  }
  if (announce) setStatus(`${current.name} mounted · ${children.length} objects`);
}

/** The camera flew into an area we have already built; adopt it without moving. */
function adoptArea(directoryId: string): void {
  const trail = ancestryById.get(directoryId);
  if (!trail || trail[trail.length - 1].id === currentDirectory().id) return;
  // An in-flight renderDirectory for the directory the camera has just left must not be
  // allowed to win the world back once its peeks resolve; bumping the generation here
  // invalidates it before this function hands the camera's chosen directory to the chrome.
  renderGeneration += 1;
  ancestry = [...trail];
  syncRoute("push");
  renderChrome();
  updateSelection(null);
  setStatus(`Entered ${currentDirectory().name}`);
}

let previousCrumbIds: string[] = [];

function renderBreadcrumbs(): void {
  breadcrumbs.replaceChildren();
  const previousLeaf = previousCrumbIds[previousCrumbIds.length - 1];
  let entering = 0;
  ancestry.forEach((node, index) => {
    if (index > 0) {
      const divider = document.createElement("span");
      divider.textContent = "/";
      divider.setAttribute("aria-hidden", "true");
      breadcrumbs.append(divider);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = index === 0 ? node.name : trimName(node.name, 18);
    const isLeaf = index === ancestry.length - 1;
    button.ariaCurrent = isLeaf ? "page" : "false";
    button.addEventListener("click", () => {
      ancestry = ancestry.slice(0, index + 1);
      void renderDirectory(true, "backward");
    }, listener);
    // Animate crumbs that are genuinely new, plus the one that just became current
    // (so stepping back reads as a change rather than a silent restyle).
    if (!welcomeHold && (!previousCrumbIds.includes(node.id) || (isLeaf && previousLeaf !== node.id))) {
      button.classList.add("is-entering");
      button.style.animationDelay = `${entering * 45}ms`;
      entering += 1;
    }
    breadcrumbs.append(button);
  });
  previousCrumbIds = ancestry.map((node) => node.id);
}

function updateSelection(node: FsNode | null): void {
  selectedNode = node;
  syncObjectRoute();
  // Something being selected changes what the foot of a small screen is for: the panel
  // is the answer to the tap, and the strip that was standing under it stands down.
  document.documentElement.toggleAttribute("data-selection", Boolean(node));
  if (!node) {
    detailsKind.textContent = "NO SELECTION";
    detailsTitle.textContent = "Select an object";
    detailsGlyph.className = "file-glyph";
    detailsList.innerHTML = `<div><dt>Path</dt><dd>-</dd></div><div><dt>Size</dt><dd>-</dd></div><div><dt>Modified</dt><dd>-</dd></div>`;
    enterButton.hidden = true;
    return;
  }
  const category = categoryOf(node);
  detailsKind.textContent = `${category.toUpperCase()} OBJECT`;
  detailsTitle.textContent = node.name;
  detailsGlyph.className = `file-glyph category-${category}`;
  detailsList.innerHTML = "";
  const metadata = [
    ["Path", pathFor(node, ancestry)],
    [node.kind === "directory" ? "Objects" : "Size", node.kind === "directory" ? String(node.children?.length ?? "Not scanned") : formatBytes(node.size)],
    ["Modified", formatDate(node.modified)],
  ];
  metadata.forEach(([term, description]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description;
    row.append(dt, dd);
    detailsList.append(row);
  });
  enterButton.hidden = false;
  enterButton.innerHTML = `${node.kind === "directory" ? "Enter directory" : "Open file"}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5M9 5h10v10" stroke-linecap="square" stroke-linejoin="miter"/></svg>`;
}

function updateHover(node: FsNode | null, x: number, y: number): void {
  if (!node) {
    hoverLabel.hidden = true;
    return;
  }
  hoverLabel.hidden = false;
  hoverLabel.textContent = `${node.kind === "directory" ? "DIR" : categoryOf(node).toUpperCase()} / ${node.name}`;
  hoverLabel.style.transform = `translate(${Math.min(x + 18, window.innerWidth - 280)}px, ${Math.min(y + 18, window.innerHeight - 60)}px)`;
}

function updateAim(node: FsNode | null): void {
  reticle.classList.toggle("has-target", Boolean(node));
  const label = reticle.querySelector("span");
  if (label) label.textContent = node ? `TARGET / ${trimName(node.name, 24)}` : "NO TARGET";
}

async function openNode(node: FsNode): Promise<void> {
  if (node.kind === "file") {
    const opened = viewer.open(node, pathFor(node, ancestry));
    // The window is up (or was refused) before `open` first waits on anything, so the
    // address can say so now rather than once the payload has finished loading.
    syncObjectRoute();
    await opened;
    return;
  }
  if (opening?.id === node.id) return;
  const generation = (openGeneration += 1);
  opening = node;
  const from = currentDirectory();
  const settle = beginPending();
  setStatus(`Scanning ${node.name}…`);
  try {
    await platform.ensureChildren(node);
    if (generation !== openGeneration || currentDirectory().id !== from.id) return;
    ancestry.push(node);
    void renderDirectory(true, "forward");
  } catch (error) {
    if (generation !== openGeneration) return;
    setStatus(error instanceof Error ? error.message : `Unable to open ${node.name}`, true);
  } finally {
    settle();
    if (generation === openGeneration) opening = null;
  }
}

let opening: FsNode | null = null;
let openGeneration = 0;

function goBack(): void {
  if (ancestry.length <= 1) return;
  ancestry.pop();
  void renderDirectory(true, "backward");
}

function goToRoot(): void {
  if (ancestry.length <= 1) {
    world.refocus();
    setStatus(`Recentred on ${currentDirectory().name}`);
    return;
  }
  ancestry = [ancestry[0]];
  void renderDirectory(true, "backward");
}

/**
 * Walks a source down to the directory a route names, reading each level on the way.
 *
 * Nothing below the root has been read when a fresh tab is restored into a deep address,
 * so this is a readdir per segment rather than a lookup. It stops at the first name that
 * is not a directory here and returns how far it got: an address that has gone stale
 * lands as close to where it pointed as the source still allows.
 */
async function resolveRoute(source: FilesystemRoot, names: string[]): Promise<FsNode[]> {
  const chain = [source.root];
  if (names[0] !== source.root.name) return chain;
  for (const name of names.slice(1)) {
    let children: FsNode[];
    try {
      children = await platform.ensureChildren(chain[chain.length - 1]);
    } catch {
      break;
    }
    const next = children.find((node) => node.kind === "directory" && node.name === name);
    if (!next) break;
    chain.push(next);
  }
  return chain;
}

/** Guards against a slow walk from an abandoned address landing after a newer one. */
let routeGeneration = 0;

/**
 * Travels to wherever the address bar now points, without writing history back, then
 * picks out the object it names there. An address for the directory already on screen
 * can still differ in its object — edited by hand, or the second of a popstate and
 * hashchange pair — and bringing the selection and window in line is all it asks for;
 * an address naming no object there puts away a window open in this directory.
 */
async function applyRoute(route: Route): Promise<void> {
  const generation = (routeGeneration += 1);
  const settle = beginPending();
  let chain: FsNode[];
  try {
    chain = await resolveRoute(filesystem, route.names);
  } finally {
    settle();
  }
  if (generation !== routeGeneration || lifecycle.signal.aborted) return;
  // An address only partly resolved is an address that lies about where we are.
  const complete = chain.length === route.names.length;
  const intent: RouteIntent = complete ? "keep" : "replace";
  const destination = chain[chain.length - 1];
  if (destination.id === currentDirectory().id) {
    syncRoute(intent);
    if (!complete) return;
    if (route.object) landObject(route.object);
    else if (viewer.shownNode?.parentId === destination.id) viewer.close();
    return;
  }
  const direction: NavigationDirection = chain.length > ancestry.length ? "forward" : "backward";
  ancestry = chain;
  await renderDirectory(true, direction, intent);
  if (complete && generation === routeGeneration && currentDirectory().id === destination.id) landObject(route.object);
}

/** Where a claimed address comes down: the directories walked, and the object to pick out at the end. */
type Landing = { chain: FsNode[]; object: RouteObject | null };

/**
 * Takes the address the page was opened with, if it names a path inside this source.
 *
 * Consumed by the first source that answers to it, since the folder named in the address
 * is the one being restored: once it is back, the address has done its work. Anything
 * else mounted first — the demo standing in behind a welcome screen, a folder waiting on
 * a click — leaves the claim untouched for whatever comes after it.
 */
async function claimPendingRoute(source: FilesystemRoot): Promise<Landing | null> {
  const wanted = pendingRoute;
  if (wanted.names[0] !== source.root.name || (wanted.names.length < 2 && !wanted.object)) return null;
  pendingRoute = noRoute;
  const chain = await resolveRoute(source, wanted.names);
  // The object is only looked for in the directory it was named in; a walk that stopped
  // short has landed somewhere else, where the same name would be a different object.
  const object = chain.length === wanted.names.length ? wanted.object : null;
  return chain.length > 1 || object ? { chain, object } : null;
}

/**
 * `announcement` replaces the standard mount line for arrivals that need explaining.
 * Resolves once the world is drawn, which is what the boot sequence waits on.
 */
async function setFilesystem(next: FilesystemRoot, announcement?: string): Promise<boolean> {
  if (lifecycle.signal.aborted || !viewer.close()) {
    if (next !== filesystem) await sourceTransition.dispose(next);
    return false;
  }
  // Walking to a restored address belongs with the rest of the preparation, so a source
  // that arrives deep arrives already deep: one world built, in the right place.
  let landing = null as Landing | null;
  const mounted = await sourceTransition.replace(
    next,
    async (candidate) => {
      await platform.ensureChildren(candidate.root);
      landing = await claimPendingRoute(candidate);
      if (lifecycle.signal.aborted) sourceTransition.invalidate();
    },
    (candidate) => {
      // Preparation can take long enough for a new editor to open. The source hand-off
      // is the destructive boundary, so consult the guard again immediately before it.
      if (lifecycle.signal.aborted || !viewer.close()) return { status: "rejected" };
      const previous = filesystem;
      filesystem = candidate;
      forgetTreeIndex();
      heldObject = null;
      ancestry = landing?.chain ?? [candidate.root];
      ancestryById.clear();
      const drawn = renderDirectory(!announcement, "initial", "replace");
      if (announcement) setStatus(announcement);
      return { status: "activated", previous, settled: drawn };
    },
  );
  if (mounted) landObject(landing?.object ?? null);
  return mounted;
}

function setStatus(message: string, isError = false): void {
  status.classList.toggle("is-error", isError);
  const text = status.querySelector("span");
  if (text) text.textContent = message;
}

async function chooseFolder(): Promise<void> {
  // Native pickers replace the adapter's active grant as part of selection. Refuse the
  // operation before opening one so a declined discard cannot revoke the editor's root.
  if (!viewer.close()) return;
  setStatus("Awaiting directory authorization…");
  try {
    const picked = await platform.pickDirectory();
    if (picked.status === "selected") {
      if (!(await setFilesystem(picked.filesystem))) return;
      void platform.rememberFilesystem(picked.filesystem);
      withdrawReopenOffer();
      welcomeDialog.close();
    } else if (picked.status === "snapshot-required" && platform.importSnapshot) {
      folderFallback.click();
      setStatus("Choose a directory snapshot");
    } else {
      setStatus("Folder selection cancelled");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setStatus("Folder selection cancelled");
      return;
    }
    setStatus(error instanceof Error ? error.message : "Folder access was denied", true);
  }
}

/**
 * Puts a remembered directory back on screen from the platform-owned reference.
 */
async function mountRememberedDirectory(source: Extract<RecalledSource, { mode: "filesystem" }>): Promise<boolean> {
  const settle = beginPending();
  try {
    const restored = source.filesystem;
    const count = restored.root.children?.length ?? 0;
    const mounted = await setFilesystem(
      restored,
      source.announcement ?? `Reopened ${restored.root.name} · ${count} ${count === 1 ? "object" : "objects"}`,
    );
    return mounted;
  } catch {
    void platform.forgetSource();
    withdrawReopenOffer();
    setStatus(`Could not reopen ${source.filesystem.root.name} — it may have been moved or renamed`, true);
    return false;
  } finally {
    settle();
  }
}

/**
 * The folder a returning visitor is owed, waiting on the one click that re-grants it.
 * Non-null only while the toolbar button is offering that folder rather than the picker.
 */
let pendingReopen: Extract<RecalledSource, { mode: "reopen" }> | null = null;

/**
 * `requestPermission` needs the click that got us here, so nothing may be awaited
 * before it. On a lapsed grant it shows the browser's own short confirmation naming
 * the folder — which is the whole point of keeping the handle rather than sending
 * someone back through the picker to find the same directory a second time.
 */
async function reopenRememberedDirectory(source: Extract<RecalledSource, { mode: "reopen" }>): Promise<void> {
  folderButton.disabled = true;
  setStatus(`Awaiting access to ${source.name}…`);
  try {
    const restored = await source.reopen();
    const count = restored.root.children?.length ?? 0;
    if (!(await setFilesystem(restored, `Reopened ${source.name} · ${count} ${count === 1 ? "object" : "objects"}`))) return;
    void platform.rememberFilesystem(restored);
    withdrawReopenOffer();
  } catch (error) {
    void platform.forgetSource();
    withdrawReopenOffer();
    setStatus(error instanceof Error ? error.message : `Access to ${source.name} was denied`, true);
  } finally {
    folderButton.disabled = false;
  }
}

/**
 * Offers the remembered folder from the toolbar instead of behind a modal.
 *
 * Chrome hands back a stored handle with its permission lapsed to "prompt" on nearly
 * every reload, so this is the ordinary path home, not an error worth blocking the
 * page for: the demo stays up, and the button that would have opened the picker
 * reopens the folder by name.
 */
function offerRememberedDirectory(source: Extract<RecalledSource, { mode: "reopen" }>): void {
  pendingReopen = source;
  folderButtonLabel.textContent = `Reopen ${trimName(source.name, 18)}`;
  folderButton.title = `Reopen ${source.name}`;
  setStatus(`${trimName(source.name, 18)} is one click away`);
}

function withdrawReopenOffer(): void {
  pendingReopen = null;
  folderButtonLabel.textContent = "Open folder";
  folderButton.removeAttribute("title");
}

/** Results are capped so a broad query returns a readable list instead of the whole tree. */
const searchResultLimit = 25;
/**
 * The most objects the whole-tree index will hold. Plenty for a project and most of a
 * home folder; past it, queries are answered from what the walk reached first, which
 * its breadth-first order makes the shallower and likelier part of the tree.
 */
const SEARCH_INDEX_LIMIT = 50_000;
/**
 * Directory reads the index keeps in flight: enough that one slow handle stalls a slot
 * rather than the walk, few enough not to crowd out the directory someone is opening.
 */
const SEARCH_INDEX_CONCURRENCY = 6;
/** How often a growing index may re-rank an open dialog; any faster reads as flicker. */
const SEARCH_PROGRESS_INTERVAL_MS = 250;

let resultButtons: HTMLButtonElement[] = [];
let resultEntries: IndexedObject[] = [];
let resultKey = "";
let activeResultIndex = -1;

/**
 * The mounted source's index, started the first time search is opened on it rather than
 * when the source mounts. Walking a whole tree costs a listing per directory — and in the
 * browser a metadata read per file — which is worth paying for someone searching and not
 * for someone who came to look at one folder. Once started it runs on in the background,
 * dialog open or not, so the next search is answered from the whole tree.
 */
let treeIndex: TreeIndex | null = null;
let treeIndexController: AbortController | null = null;

function indexForSearch(): TreeIndex {
  if (treeIndex?.root === filesystem.root) return treeIndex;
  forgetTreeIndex();
  const controller = new AbortController();
  const index = new TreeIndex(filesystem.root, {
    read: (node) => platform.ensureChildren(node),
    signal: controller.signal,
    limit: SEARCH_INDEX_LIMIT,
    concurrency: SEARCH_INDEX_CONCURRENCY,
    onProgress: () => {
      if (treeIndex === index) scheduleIndexRender();
    },
  });
  treeIndex = index;
  treeIndexController = controller;
  return index;
}

/** Stops the walk over a source that is going away; its partial index goes with it. */
function forgetTreeIndex(): void {
  treeIndexController?.abort();
  treeIndexController = null;
  treeIndex = null;
  window.clearTimeout(indexRenderTimer);
  indexRenderTimer = 0;
}

let indexRenderTimer = 0;
let lastSearchRender = 0;

/**
 * Lets an open dialog catch up with a growing index at a steady pace. The walk reports
 * each time it yields, which on a fast source is every frame, and re-ranking that often
 * would spend the very frames the walk just handed back.
 */
function scheduleIndexRender(): void {
  if (!searchDialog.open || indexRenderTimer) return;
  const wait = Math.max(0, lastSearchRender + SEARCH_PROGRESS_INTERVAL_MS - performance.now());
  indexRenderTimer = window.setTimeout(() => {
    indexRenderTimer = 0;
    if (!lifecycle.signal.aborted && searchDialog.open) renderSearchResults(searchInput.value, true);
  }, wait);
}

function openSearch(): void {
  searchInput.value = "";
  searchInput.placeholder = `Search all of ${filesystem.root.name}…`;
  renderSearchResults("");
  searchDialog.showModal();
  searchInput.focus();
}

/**
 * `keepActive` is for a list refreshed underneath someone — the index grew — where the
 * row they had arrowed to should stay theirs. A new query starts again from the top.
 */
function renderSearchResults(query: string, keepActive = false): void {
  lastSearchRender = performance.now();
  const index = indexForSearch();
  renderIndexProgress(index);
  const trimmed = query.trim();

  if (!trimmed) {
    // An empty box browses the level you are standing on; listing whole trees is noise.
    const children = currentChildren();
    searchCount.textContent = children.length > searchResultLimit
      ? `Showing ${searchResultLimit} of ${children.length} objects here`
      : `${children.length} ${children.length === 1 ? "object" : "objects"} here`;
    renderMatches(indexChildren(ancestry, children.slice(0, searchResultLimit)), false, keepActive);
    return;
  }

  const outcome = searchIndex(index.entries, trimmed, { limit: searchResultLimit, here: currentDirectory().id });
  const total = outcome.total.toLocaleString("en-US");
  searchCount.textContent = outcome.total > outcome.matches.length
    ? `Showing ${outcome.matches.length} of ${total}, refine to narrow`
    : `${total} ${outcome.total === 1 ? "match" : "matches"}`;
  renderMatches(outcome.matches, true, keepActive);
}

/**
 * Kept apart from the match count, and out of its live region: the count is the answer
 * to what was typed and worth announcing, while this ticks over several times a second
 * for as long as the walk runs and would drown it out.
 */
function renderIndexProgress(index: TreeIndex): void {
  const count = index.entries.length;
  const objects = `${count.toLocaleString("en-US")} ${count === 1 ? "object" : "objects"}`;
  const unreadable = index.unreadable
    ? ` · ${index.unreadable} ${index.unreadable === 1 ? "directory" : "directories"} unreadable`
    : "";
  searchProgress.dataset.state = index.status;
  searchProgress.textContent = index.status === "indexing"
    ? `Indexed ${objects}…${unreadable}`
    : index.status === "capped"
      ? `Index stops at ${objects}${unreadable}`
      : `${objects} indexed${unreadable}`;
}

function renderMatches(entries: IndexedObject[], showLocation: boolean, keepActive: boolean): void {
  // A growing index re-ranks to the same list most of the time; rebuilding identical rows
  // would only flicker under the pointer and throw away the row being hovered.
  const key = `${showLocation}\n${entries.map((entry) => entry.node.id).join("\n")}`;
  if (entries.length && key === resultKey) return;
  const activeId = keepActive ? resultEntries[activeResultIndex]?.node.id : undefined;
  resultKey = key;
  resultEntries = entries;
  resultButtons = [];
  searchResults.replaceChildren();
  if (!entries.length) {
    searchResults.append(emptyResult(treeIndex?.status === "indexing" ? "NO MATCHES YET · STILL INDEXING" : "NO MATCHING OBJECTS"));
    setActiveResult(-1);
    return;
  }
  entries.forEach((entry, index) => {
    const { node } = entry;
    const item = el("li");
    const button = el("button");
    button.type = "button";
    button.id = `search-result-${index}`;
    button.role = "option";
    const glyph = el("i", `result-glyph category-${categoryOf(node)}`);
    glyph.ariaHidden = "true";
    const measure = node.kind === "directory" ? `${node.children?.length ?? "?"} objects` : formatBytes(node.size);
    const detail = el("small", undefined, measure);
    if (showLocation) detail.append(" · ", el("span", "result-location", locationOf(entry)));
    const text = el("span");
    text.append(el("strong", undefined, node.name), detail);
    button.append(glyph, text, el("kbd", "key-glyph", "↵"));
    button.addEventListener("click", () => void revealMatch(entry), listener);
    // Keep pointer and keyboard on the same row, so there is only ever one highlight.
    button.addEventListener("pointerenter", () => setActiveResult(index), listener);
    item.append(button);
    searchResults.append(item);
    resultButtons.push(button);
  });
  const kept = activeId === undefined ? -1 : entries.findIndex((entry) => entry.node.id === activeId);
  setActiveResult(Math.max(kept, 0));
}

/** Highlights a result without moving focus; the input keeps it so typing never breaks. */
function setActiveResult(index: number): void {
  activeResultIndex = resultButtons.length ? Math.max(0, Math.min(index, resultButtons.length - 1)) : -1;
  resultButtons.forEach((button, position) => {
    const isActive = position === activeResultIndex;
    button.classList.toggle("is-active", isActive);
    button.ariaSelected = String(isActive);
  });
  const active = resultButtons[activeResultIndex];
  searchInput.setAttribute("aria-activedescendant", active?.id ?? "");
  active?.scrollIntoView({ block: "nearest" });
}

function moveActiveResult(step: number): void {
  if (!resultButtons.length) return;
  const next = (activeResultIndex + step + resultButtons.length) % resultButtons.length;
  setActiveResult(next);
}

function emptyResult(message: string): HTMLLIElement {
  return el("li", "search-empty", message);
}

/**
 * A result is a destination, not a highlight: the directory holding it is travelled to,
 * since a match from elsewhere in the tree has no district on screen to show it in, and
 * then the object is framed and selected there.
 *
 * A directory goes one step further and is entered, because that is the only thing to
 * do with one. A file stops at being selected: now that search reaches the whole tree, a
 * result is often somewhere never visited, and landing beside it — seeing what it sits
 * among — is the point of flying there. Opening it is then one more press away.
 *
 * The travel is awaited rather than fired off. Building a district takes the camera and
 * clears the selection, so a match framed before it lands is a match it un-frames.
 */
async function revealMatch(entry: IndexedObject): Promise<void> {
  searchDialog.close();
  const destination = entry.trail[entry.trail.length - 1];
  if (destination.id !== currentDirectory().id) {
    const direction: NavigationDirection = entry.trail.length > ancestry.length ? "forward" : "backward";
    ancestry = [...entry.trail];
    await renderDirectory(true, direction);
  }
  world.focusNode(entry.node);
  if (entry.node.kind === "directory") {
    await openNode(entry.node);
    return;
  }
  if (selectedNode?.id === entry.node.id) setStatus(`Found ${entry.node.name} in ${locationOf(entry)}`);
}

function trimName(name: string, length: number): string {
  return name.length > length ? `${name.slice(0, length - 1)}…` : name;
}

/** Coalesces keystrokes: the walk is synchronous on the frame thread, so re-running it on
 * every keydown would block rendering for as long as the user keeps typing. */
const searchRenderDelayMs = 90;
let searchRenderTimer = 0;
function scheduleSearchRender(): void {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = window.setTimeout(() => {
    searchRenderTimer = 0;
    if (!lifecycle.signal.aborted) renderSearchResults(searchInput.value);
  }, searchRenderDelayMs);
}
function flushSearchRender(): void {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = 0;
  renderSearchResults(searchInput.value);
}

folderButton.addEventListener("click", () => void (pendingReopen ? reopenRememberedDirectory(pendingReopen) : chooseFolder()), listener);
demoButton.addEventListener("click", () => {
  void (async () => {
    if (await setFilesystem(createDemoFilesystem(platform.demoResources))) await platform.rememberDemo();
  })();
}, listener);
enterButton.addEventListener("click", () => selectedNode && void openNode(selectedNode), listener);
searchButton.addEventListener("click", openSearch, listener);
helpButton.addEventListener("click", () => helpDialog.showModal(), listener);
// Escape is the desktop way out of these, and pressing the page behind them is the
// same gesture for a hand that has no Escape key to reach for.
[searchDialog, helpDialog, welcomeDialog].forEach((dialog) => dismissOnOutsidePress(dialog, listener));
searchInput.addEventListener("input", scheduleSearchRender, listener);
searchDialog.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveActiveResult(event.key === "ArrowDown" ? 1 : -1);
    // Arrows anywhere in the dialog drive the list, so hand typing back to the input.
    searchInput.focus();
    return;
  }
  // Enter from the input opens the highlighted result; the dialog's own buttons keep theirs.
  if (event.key === "Enter" && event.target === searchInput) {
    // A pending debounced render must land first, or Enter can open whatever the stale
    // list last highlighted. Only flush when a timer is actually pending — an
    // unconditional flush would rebuild the list and reset the user's arrow-key selection.
    if (searchRenderTimer) flushSearchRender();
    const active = resultButtons[activeResultIndex];
    if (!active) return;
    event.preventDefault();
    active.click();
  }
}, listener);
folderFallback.addEventListener("change", () => {
  if (!folderFallback.files || !platform.importSnapshot) return;
  const imported = platform.importSnapshot(folderFallback.files);
  if (imported) {
    void setFilesystem(imported).then((mounted) => {
      if (mounted) welcomeDialog.close();
    });
  }
  folderFallback.value = "";
}, listener);
// The mark carries the root's own address, so opening it in a new tab lands there
// rather than following a bare `#`. Handled here when it is an ordinary click, since
// going home also recentres the camera when it is already the directory we are in.
brandHome.addEventListener("click", (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  goToRoot();
}, listener);
welcomeDemo.addEventListener("click", () => welcomeDialog.close(), listener);
/**
 * Dismissing the welcome screen is itself a choice. Whichever way it was closed —
 * the demo button, Escape, the backdrop — leaving on the demo means the demo is what
 * should come back next time, so the screen is never shown to the same person twice.
 * A folder mounted from inside the dialog has already recorded itself.
 */
welcomeDialog.addEventListener("close", () => {
  releaseWhenWelcomeHasGone();
  if (!filesystem.isLocal) void platform.rememberDemo();
}, listener);

getElement<HTMLButtonElement>("welcome-folder").addEventListener("click", () => void chooseFolder(), listener);

/**
 * Waits for the screen to be gone rather than merely dismissed. Its backdrop is a
 * full-viewport blur, the most expensive thing this page ever composites, and a camera
 * that starts moving while that is still dissolving moves in dropped frames.
 *
 * The transition announces its own end, so this tracks the stylesheet instead of
 * repeating its numbers. The timer is the failsafe for a close that never animates.
 */
function releaseWhenWelcomeHasGone(): void {
  let failsafe = 0;
  const release = (): void => {
    window.clearTimeout(failsafe);
    welcomeDialog.removeEventListener("transitionend", onDialogTransitionEnd);
    if (!lifecycle.signal.aborted) releaseBehindWelcome();
  };
  const onDialogTransitionEnd = (event: TransitionEvent): void => {
    if (event.target === welcomeDialog && event.propertyName === "opacity") release();
  };
  welcomeDialog.addEventListener("transitionend", onDialogTransitionEnd, listener);
  failsafe = window.setTimeout(release, 400);
}

window.addEventListener("keydown", (event) => {
  // Camera movement keys are owned by WorldScene; it reports back via onKeyboardNavigation.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!searchDialog.open) openSearch();
    return;
  }
  if (event.key === "?" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    helpDialog.showModal();
    return;
  }
  if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    if (!searchDialog.open) openSearch();
    return;
  }
  if (event.key === "Backspace" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    goBack();
  }
  // A dialog owns Escape while it is open; the browser closes it for us.
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    goBack();
  }
  if (event.key === "Home" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    world.refocus();
    setStatus(`Recentred on ${currentDirectory().name}`);
  }
  const sceneFocused = document.activeElement === document.body || document.activeElement === canvas;
  if (event.key.toLowerCase() === "e" && sceneFocused) {
    const aimed = world.selectAimed();
    if (aimed) {
      event.preventDefault();
      setStatus(`${aimed.name} targeted · Enter to open`);
    }
  }
  if (event.key === "Enter" && sceneFocused) {
    const target = world.getAimedNode() ?? selectedNode;
    if (target) {
      event.preventDefault();
      void openNode(target);
    }
  }
}, listener);

window.addEventListener("pointerdown", (event) => {
  if (event.button === 0) world.setKeyboardNavigationActive(false);
}, listener);

// Back and forward are directory navigation. `popstate` covers every traversal of the
// entries this page wrote; `hashchange` covers an address typed or edited by hand, which
// writes no entry of ours to traverse. A browser that fires both for one step arrives
// twice at the same directory, and the second arrival has nothing left to do.
window.addEventListener("popstate", () => void applyRoute(readRoute(window.location.hash)), listener);
// Every way a window is put away — its lights, Escape, a press outside, a newer source —
// ends in this event, after the viewer has already forgotten what it was showing.
viewerDialog.addEventListener("close", syncObjectRoute, listener);
window.addEventListener("hashchange", () => void applyRoute(readRoute(window.location.hash)), listener);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Draws whatever the last visit earned, and reports whether the welcome screen is
 * still owed. Only two things earn it: never having been here, and a remembered
 * folder that has gone missing.
 *
 * A folder comes straight back when its grant survived — Chromium keeps one alive for
 * folders the user has made persistent — and otherwise waits in the toolbar, since
 * `requestPermission` cannot be called without a click no matter where it comes from.
 * Every branch ends with exactly one world drawn, so nothing is rendered twice.
 */
async function settleInitialView(): Promise<boolean> {
  const last = await platform.recallSource();
  if (last.mode === "filesystem" && (await mountRememberedDirectory(last))) return false;
  if (last.mode === "reopen") {
    // The address still names the folder the toolbar is offering, and it is wanted again
    // if this page is reloaded before that button is pressed. The demo standing in behind
    // it has not been navigated to and does not get to overwrite where we were.
    await renderDirectory(false, "initial", "keep");
    offerRememberedDirectory(last);
    return false;
  }
  if (last.mode === "missing") {
    setStatus(last.message, true);
  }
  // Everything from here earns the welcome screen, so the world it is covering holds
  // its reveal until the screen is gone. Whatever is mounted from inside the dialog
  // is held too: the hold outlives this render and lifts when the dialog closes.
  //
  // Which is also the only thing that lifts it. A render that never finishes is a
  // welcome screen that never opens, and a skyline left flat with no way to raise it.
  const owed = last.mode !== "demo";
  if (owed) holdBehindWelcome();
  try {
    // The demo is a real source with real directories, so an address into it is restored
    // like any other. This one is already mounted, so the walk happens here.
    const landing = await claimPendingRoute(filesystem);
    if (landing) ancestry = landing.chain;
    await renderDirectory(false, "initial", "replace");
    landObject(landing?.object ?? null);
  } catch (error) {
    releaseBehindWelcome();
    throw error;
  }
  return owed;
}

/**
 * Reveals the interface once. When a welcome screen is owed it opens in the same frame,
 * so the two arrive as one event rather than as an interface fading up from black and
 * then a dialog landing on top of it. The beat that used to separate them was there to
 * keep the heading from animating in under a backdrop that was blurring it; the heading
 * no longer animates at all until the screen is gone, so there is nothing left to
 * protect and the pause had become the thing worth removing.
 *
 * The race is the concession to big directories — reading a few thousand entries is
 * slower than anyone should stare at a black page for, so the demo backdrop comes up
 * on time and the real folder lands in it when it is ready. That is also the one case
 * where the two can still separate, and getting on screen matters more there.
 */
async function start(): Promise<void> {
  const settled = settleInitialView();
  try {
    await Promise.race([settled, wait(600)]);
    if (lifecycle.signal.aborted) return;
    // Awaiting a settled promise yields a microtask, not a frame: both land on one paint.
    if (!(await settled) || lifecycle.signal.aborted) return;
    welcomeDialog.showModal();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Startup failed", true);
  } finally {
    document.documentElement.dataset.boot = "ready";
  }
}

void start();

return {
  requestClose: () => viewer.confirmDiscard(),
  destroy: () => {
    if (destroyPromise) return destroyPromise;
    lifecycle.abort();
    forgetTreeIndex();
    document.documentElement.removeAttribute("data-selection");
    sourceTransition.invalidate();
    renderGeneration += 1;
    viewer.destroy();
    world.destroy();
    destroyPromise = sourceTransition.dispose(filesystem);
    return destroyPromise;
  },
};
}
