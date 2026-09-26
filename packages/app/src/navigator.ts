import {
  categoryOf,
  combineUsage,
  createGitStatusIndex,
  formatBytes,
  formatDate,
  formatUsage,
  formatUsageBytes,
  pathFor,
  searchFilesystem,
  sortNodes,
  unreadDirectoriesUnder,
  usageOfLoadedTree,
  type DirectoryUsage,
  type FilesystemRoot,
  type FsNode,
  type GitStatusIndex,
  type SearchMatch,
  type SearchOutcome,
} from "@fsn/core";
import { createDemoFilesystem } from "./demo";
import { LatestSourceTransition } from "./filesystem-transition";
import {
  createAgeLens,
  createGitLens,
  legendFor,
  lensStorage,
  readLensChoice,
  writeLensChoice,
  type ColourMode,
  type LensChoice,
} from "./lens";
import { dismissOnOutsidePress } from "./light-dismiss";
import type { NavigatorPlatform, RecalledSource } from "./platform";
import { readRoute, routeFor, sameRoute } from "./route";
import { WorldScene, type NavigationDirection } from "./scene";
import { FileViewer } from "./viewer";

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
const searchDeepen = getElement<HTMLButtonElement>("search-deepen");
const scopeSwitch = getElement<HTMLElement>("scope-switch");
const scopeCurrentButton = getElement<HTMLButtonElement>("scope-current");
const scopeAllButton = getElement<HTMLButtonElement>("scope-all");
const helpDialog = getElement<HTMLDialogElement>("help-dialog");
const helpButton = getElement<HTMLButtonElement>("help-button");
const welcomeDialog = getElement<HTMLDialogElement>("welcome-dialog");
const welcomeDemo = getElement<HTMLButtonElement>("welcome-demo");
const folderButtonLabel = getElement<HTMLElement>("folder-button-label");
const brandHome = getElement<HTMLAnchorElement>("brand-home");
const lensButton = getElement<HTMLButtonElement>("lens-button");
const lensPanel = getElement<HTMLElement>("lens-panel");
const lensProgress = getElement<HTMLElement>("lens-progress");
const legendTitle = getElement<HTMLElement>("legend-title");
const legendList = getElement<HTMLUListElement>("legend-list");
const sizeButtons = [...lensPanel.querySelectorAll<HTMLButtonElement>("[data-lens-size]")];
const colourButtons = [...lensPanel.querySelectorAll<HTMLButtonElement>("[data-lens-colour]")];
/** The type legend as the shell wrote it, restored whenever the type lens comes back. */
const typeLegend = [...legendList.children].map((item) => item.cloneNode(true));

// The hidden FileList fallback is a browser-only escape hatch. Keeping it focusable
// in the native shell would expose an inert control to keyboard and screen-reader users.
if (!platform.importSnapshot) folderFallback.hidden = true;

const viewer = new FileViewer(
  {
    dialog: getElement<HTMLDialogElement>("file-viewer"),
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

/**
 * The lens a viewer last chose, applied before the first district is drawn so the city
 * arrives already in it rather than being rebuilt a moment later. Everything a lens needs
 * to know — totals, git status — belongs to the source on screen and is dropped with it.
 */
const lensStore = lensStorage();
let lens: LensChoice = readLensChoice(lensStore);
let gitIndex: GitStatusIndex | null = null;
let appliedColour: ColourMode = "type";
world.setDirectorySize(lens.size);

/** The git lens is only offered, and only honoured, once there is a status to show. */
function effectiveColour(): ColourMode {
  return lens.colour === "git" && !gitIndex ? "type" : lens.colour;
}

/**
 * Where a node lives below the open folder, as names, for matching against git's paths.
 * Only directories that have been walked into are known here, which is every directory a
 * district has been built for, so every object on screen has an answer.
 */
function pathBelowRoot(node: FsNode): string[] | null {
  const own = node.kind === "directory" ? ancestryById.get(node.id) : undefined;
  if (own) return own.slice(1).map((part) => part.name);
  const parent = node.parentId ? ancestryById.get(node.parentId) : undefined;
  return parent ? [...parent.slice(1).map((part) => part.name), node.name] : null;
}

function applyColourLens(force = false): void {
  const mode = effectiveColour();
  // Repainting relabels every name on screen, which is worth doing for new data but not
  // for a choice that changed nothing.
  if (mode === "type" && appliedColour === "type" && !force) {
    renderLensControls();
    return;
  }
  appliedColour = mode;
  if (mode === "age") world.setColourLens(createAgeLens(Date.now()));
  else if (mode === "git" && gitIndex) world.setColourLens(createGitLens(gitIndex, pathBelowRoot));
  else world.setColourLens(null);
  renderLegend();
  renderLensControls();
}

function renderLensControls(): void {
  const colour = effectiveColour();
  sizeButtons.forEach((button) => (button.ariaPressed = String(button.dataset.lensSize === lens.size)));
  colourButtons.forEach((button) => {
    button.ariaPressed = String(button.dataset.lensColour === colour);
    if (button.dataset.lensColour === "git") button.hidden = !gitIndex;
  });
}

function renderLegend(): void {
  const mode = effectiveColour();
  if (mode === "type") {
    legendTitle.textContent = "OBJECT TYPES";
    legendList.replaceChildren(...typeLegend.map((item) => item.cloneNode(true)));
    return;
  }
  const { title, rows } = legendFor(mode);
  legendTitle.textContent = title;
  const items = rows.map((row) => {
    const item = document.createElement("li");
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.setProperty("--swatch", `#${row.color.toString(16).padStart(6, "0")}`);
    item.append(swatch, row.label);
    return item;
  });
  if (mode === "git" && gitIndex?.truncated) {
    const note = document.createElement("li");
    note.className = "legend-note";
    note.textContent = "Showing the first 20,000 changes";
    items.push(note);
  }
  legendList.replaceChildren(...items);
}

function chooseSize(size: LensChoice["size"]): void {
  if (lens.size === size) return;
  lens = { ...lens, size };
  writeLensChoice(lensStore, lens);
  if (size === "total") fillLoadedTotals(currentChildren());
  world.setDirectorySize(size);
  renderLensControls();
  measureCurrentDirectory();
  setStatus(size === "total" ? "Folder heights show everything inside them" : "Folder heights show their own listing");
}

function chooseColour(colour: ColourMode): void {
  lens = { ...lens, colour };
  writeLensChoice(lensStore, lens);
  // Git is read again each time it is asked for, since the work tree may have moved on.
  if (colour === "git") void refreshGitStatus();
  applyColourLens();
  if (selectedNode) updateSelection(selectedNode);
}

let gitRequest = 0;

/** Reads the open folder's git status, if the platform can and the folder is in a work tree. */
async function refreshGitStatus(): Promise<void> {
  const request = (gitRequest += 1);
  const source = filesystem;
  let index: GitStatusIndex | null = null;
  if (platform.gitStatus && source.isLocal) {
    try {
      const report = await platform.gitStatus(source);
      index = report ? createGitStatusIndex(report) : null;
    } catch (error) {
      if (request === gitRequest && lens.colour === "git") {
        setStatus(error instanceof Error ? error.message : "Git status is unavailable", true);
      }
    }
  }
  if (request !== gitRequest || source !== filesystem || lifecycle.signal.aborted) return;
  gitIndex = index;
  applyColourLens(effectiveColour() === "git");
  if (selectedNode) updateSelection(selectedNode);
}

let lensOpen = false;

/** Unfolds the panel under the toolbar on a narrow screen; on a wide one it never folds. */
function setLensOpen(open: boolean): void {
  lensOpen = open;
  document.documentElement.toggleAttribute("data-lens-open", open);
  lensButton.setAttribute("aria-expanded", String(open));
}

/** How often a long measurement lays its district out again with the totals so far. */
const MEASURE_REFRESH_INTERVAL = 1200;
/** Progress text is a courtesy; rewriting it faster than this is layout work for nothing. */
const MEASURE_PROGRESS_INTERVAL = 150;
let measuring: AbortController | null = null;
let measuringId: string | null = null;
/** Directories that could not be measured on this source, so a render does not retry them forever. */
const unmeasurable = new Set<string>();

/** How much of an in-memory tree is counted on the spot, before a layout, per folder. */
const LOADED_TOTAL_LIMIT = 50_000;

/**
 * Totals the folders whose whole tree is already in memory — every folder of the demo, or
 * of a snapshot import — before the district is laid out, so it is built at its final
 * heights instead of rising flat and being rebuilt a moment later. Anything that would
 * need a read is left to `measureCurrentDirectory`.
 */
function fillLoadedTotals(children: FsNode[]): void {
  for (const node of children) {
    if (node.kind !== "directory" || node.usage || !node.children) continue;
    const usage = usageOfLoadedTree(node, LOADED_TOTAL_LIMIT);
    if (usage.complete) node.usage = usage;
  }
}

function measureUsage(node: FsNode, signal: AbortSignal, onProgress: (usage: DirectoryUsage) => void): Promise<DirectoryUsage> {
  // The demo lives wholly in memory, so totalling it needs nothing from the platform.
  if (filesystem.isLocal && platform.measureDirectory) return platform.measureDirectory(node, signal, onProgress);
  return Promise.resolve(usageOfLoadedTree(node));
}

function showMeasuring(text: string | null): void {
  lensProgress.hidden = text === null;
  lensProgress.textContent = text ?? "";
  document.documentElement.toggleAttribute("data-measuring", text !== null);
}

/**
 * Totals every folder standing in the current district, one after another, while the
 * size lens asks for totals. Each walk is the platform's to bound and to run off the
 * frame; this only sequences them, lays the district out again as totals land, and
 * abandons the lot the moment the view moves on to another directory or source.
 */
function measureCurrentDirectory(): void {
  measuring?.abort();
  measuring = null;
  measuringId = null;
  if (lens.size !== "total" || lifecycle.signal.aborted) {
    showMeasuring(null);
    return;
  }
  const directory = currentDirectory();
  const source = filesystem;
  const pending = currentChildren().filter((node) => node.kind === "directory" && !node.usage && !unmeasurable.has(node.id));
  if (!pending.length) {
    showMeasuring(null);
    settleDirectoryTotal(directory);
    return;
  }
  const controller = new AbortController();
  measuring = controller;
  const { signal } = controller;
  const stillWanted = (): boolean => !signal.aborted && source === filesystem && !lifecycle.signal.aborted;
  void (async () => {
    let lastRefresh = performance.now();
    let lastProgress = 0;
    let measuredBytes = 0;
    let dirty = false;
    for (const [index, node] of pending.entries()) {
      const step = `Measuring ${index + 1}/${pending.length}`;
      showMeasuring(`${step} · ${formatBytes(measuredBytes)}`);
      measuringId = node.id;
      if (selectedNode?.id === node.id) updateSelection(selectedNode);
      try {
        const usage = await measureUsage(node, signal, (partial) => {
          const now = performance.now();
          if (now - lastProgress < MEASURE_PROGRESS_INTERVAL || !stillWanted()) return;
          lastProgress = now;
          showMeasuring(`${step} · ${formatBytes(measuredBytes + partial.bytes)}`);
        });
        if (!stillWanted()) return;
        node.usage = usage;
        measuredBytes += usage.bytes;
        dirty = true;
      } catch {
        if (!stillWanted()) return;
        unmeasurable.add(node.id);
      }
      if (selectedNode?.id === node.id) updateSelection(selectedNode);
      if (dirty && performance.now() - lastRefresh > MEASURE_REFRESH_INTERVAL) {
        world.refreshArea(directory.id);
        dirty = false;
        lastRefresh = performance.now();
      }
    }
    if (measuring !== controller) return;
    measuring = null;
    measuringId = null;
    if (dirty) world.refreshArea(directory.id);
    showMeasuring(null);
    settleDirectoryTotal(directory);
  })();
}

/**
 * Once every folder in it is measured, the directory itself has a total for free: its
 * own files plus theirs. It is kept, so the district one level up can raise this
 * directory's plot without walking it again.
 */
function settleDirectoryTotal(directory: FsNode): void {
  if (!directory.usage && directory.children) {
    directory.usage = combineUsage(directory.children);
    if (directory.parentId) world.refreshArea(directory.parentId);
  }
  if (currentDirectory().id === directory.id) renderChrome();
  if (selectedNode) updateSelection(selectedNode);
  // The newest change beneath each folder arrives with its total, and age reads it.
  if (effectiveColour() === "age") applyColourLens(true);
}

function describeTotal(node: FsNode): string {
  if (node.usage) return formatUsage(node.usage);
  if (measuringId === node.id) return "Measuring…";
  return lens.size === "total" && !unmeasurable.has(node.id) ? "Waiting to measure" : "Not measured";
}

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
let pendingRoute = readRoute(window.location.hash);

function syncRoute(intent: RouteIntent): void {
  if (intent === "keep") return;
  // Going somewhere deliberately answers the opening address, whether or not it was the
  // place asked for. Nothing later is allowed to drag a mounted source back to it.
  if (intent === "push") pendingRoute = [];
  const names = ancestry.map((node) => node.name);
  if (sameRoute(names, readRoute(window.location.hash))) return;
  const url = routeFor(names);
  if (intent === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
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
  const total = current.usage ? ` · ${formatUsageBytes(current.usage)} in all` : "";
  directorySummary.textContent = `${children.length} objects · ${directories} ${directories === 1 ? "directory" : "directories"} · ${files} ${files === 1 ? "file" : "files"}${total}`;
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
  if (lens.size === "total") fillLoadedTotals(children);

  try {
    world.setDirectory(current, children, direction);
    measureCurrentDirectory();
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
  measureCurrentDirectory();
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
  if (node.kind === "directory") metadata.splice(2, 0, ["Total", describeTotal(node)]);
  if (effectiveColour() === "git" && gitIndex) {
    const segments = pathBelowRoot(node);
    const state = segments ? gitIndex.stateAt(segments, node.kind) : null;
    if (state) metadata.push(["Git", state.charAt(0).toUpperCase() + state.slice(1)]);
  }
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
    await viewer.open(node, pathFor(node, ancestry));
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

/** Travels to wherever the address bar now points, without writing history back. */
async function applyRoute(names: string[]): Promise<void> {
  const generation = (routeGeneration += 1);
  const settle = beginPending();
  let chain: FsNode[];
  try {
    chain = await resolveRoute(filesystem, names);
  } finally {
    settle();
  }
  if (generation !== routeGeneration || lifecycle.signal.aborted) return;
  // An address only partly resolved is an address that lies about where we are.
  const intent: RouteIntent = chain.length === names.length ? "keep" : "replace";
  const destination = chain[chain.length - 1];
  if (destination.id === currentDirectory().id) {
    syncRoute(intent);
    return;
  }
  const direction: NavigationDirection = chain.length > ancestry.length ? "forward" : "backward";
  ancestry = chain;
  await renderDirectory(true, direction, intent);
}

/**
 * Takes the address the page was opened with, if it names a path inside this source.
 *
 * Consumed by the first source that answers to it, since the folder named in the address
 * is the one being restored: once it is back, the address has done its work. Anything
 * else mounted first — the demo standing in behind a welcome screen, a folder waiting on
 * a click — leaves the claim untouched for whatever comes after it.
 */
async function claimPendingRoute(source: FilesystemRoot): Promise<FsNode[] | null> {
  if (pendingRoute.length < 2 || pendingRoute[0] !== source.root.name) return null;
  const wanted = pendingRoute;
  pendingRoute = [];
  const chain = await resolveRoute(source, wanted);
  return chain.length > 1 ? chain : null;
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
  let landing: FsNode[] | null = null;
  return sourceTransition.replace(
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
      ancestry = landing ?? [candidate.root];
      ancestryById.clear();
      // Totals and status belong to the source they were read from.
      unmeasurable.clear();
      gitIndex = null;
      void refreshGitStatus();
      const drawn = renderDirectory(!announcement, "initial", "replace");
      if (announcement) setStatus(announcement);
      return { status: "activated", previous, settled: drawn };
    },
  );
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
let searchScope: "current" | "all" = "current";
let resultButtons: HTMLButtonElement[] = [];
let activeResultIndex = -1;

/** How many unread directories one click of READ DEEPER pulls in. */
const SEARCH_DEEPEN_BATCH = 64;
/** How many of those reads run at once, so one slow handle does not stall the rest of the batch. */
const SEARCH_DEEPEN_CONCURRENCY = 8;
/**
 * Directories this dialog session already tried to read — successfully or not. Scoped
 * to one dialog's lifetime and cleared on open, so a permission grant made after closing
 * search gets a fresh chance instead of being remembered as a dead end forever.
 */
const attemptedUnread = new Set<string>();

function openSearch(): void {
  searchInput.value = "";
  attemptedUnread.clear();
  applySearchScope(searchScope);
  searchDialog.showModal();
  searchInput.focus();
}

function applySearchScope(scope: "current" | "all"): void {
  searchScope = scope;
  const effective = effectiveSearchScope();
  // At the root the two scopes cover the same tree, so offering the choice is just noise.
  scopeSwitch.hidden = ancestry.length === 1;
  scopeCurrentButton.ariaPressed = String(effective === "current");
  scopeAllButton.ariaPressed = String(effective === "all");
  searchInput.placeholder = scopeSwitch.hidden || effective === "all"
    ? "Search everything loaded…"
    : "Search this directory and below…";
  renderSearchResults(searchInput.value);
}

/** The stored preference survives a trip to the root, where it cannot mean anything. */
function effectiveSearchScope(): "current" | "all" {
  return ancestry.length === 1 ? "current" : searchScope;
}

function renderSearchResults(query: string): void {
  searchResults.replaceChildren();
  resultButtons = [];
  const trimmed = query.trim();
  const scope = effectiveSearchScope();

  if (!trimmed) {
    // An empty box browses the level you are standing on; listing whole trees is noise.
    // There is no search outcome to deepen here, so the button stays out of the way.
    searchDeepen.hidden = true;
    if (scope === "all") {
      searchCount.textContent = "";
      searchResults.append(emptyResult("TYPE TO SEARCH EVERY LOADED OBJECT"));
      setActiveResult(-1);
      return;
    }
    const children = currentChildren();
    searchCount.textContent = children.length > searchResultLimit
      ? `Showing ${searchResultLimit} of ${children.length} objects here`
      : `${children.length} ${children.length === 1 ? "object" : "objects"} here`;
    renderMatches(children.slice(0, searchResultLimit).map((node) => ({ node, trail: ancestry })));
    return;
  }

  // Both scopes search nested directories; they differ only in where the walk starts.
  const base = scope === "all" ? [filesystem.root] : ancestry;
  const outcome = searchFilesystem(base, trimmed, { limit: searchResultLimit });
  searchCount.textContent = describeOutcome(outcome);
  renderMatches(outcome.matches);
  updateDeepenButton(outcome, scope);
}

/**
 * Shows READ DEEPER only when there is somewhere left to read: the search itself
 * reported unread directories, and the frontier under this scope (minus whatever this
 * dialog session already tried) is not empty. The bounded walk below is what the click
 * would read anyway, so computing it here is not a second full search — it is capped at
 * the same batch size and doubles as the count in the button's label.
 */
function updateDeepenButton(outcome: SearchOutcome, scope: "current" | "all"): void {
  if (outcome.unreadDirectories === 0) {
    searchDeepen.hidden = true;
    return;
  }
  const scopeBase = scope === "all" ? filesystem.root : currentDirectory();
  const frontier = unreadDirectoriesUnder(scopeBase, SEARCH_DEEPEN_BATCH, attemptedUnread);
  searchDeepen.hidden = frontier.length === 0;
  if (frontier.length > 0) {
    searchDeepen.textContent = `READ ${Math.min(frontier.length, SEARCH_DEEPEN_BATCH)} MORE DIRECTORIES`;
  }
}

/**
 * Reads a batch of the unread frontier through the platform adapter, then re-runs the
 * query so results, counts and the button itself all catch up to what got read. A
 * directory that fails (denied, vanished) just stays unread — it is marked attempted so
 * this session will not spend another read on it.
 */
async function deepenSearch(): Promise<void> {
  const scope = effectiveSearchScope();
  const scopeBase = scope === "all" ? filesystem.root : currentDirectory();
  const frontier = unreadDirectoriesUnder(scopeBase, SEARCH_DEEPEN_BATCH, attemptedUnread);
  if (!frontier.length) return;
  for (const node of frontier) attemptedUnread.add(node.id);
  searchDeepen.disabled = true;
  const settle = beginPending();
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < frontier.length) {
        const node = frontier[next];
        next += 1;
        try {
          await platform.ensureChildren(node);
        } catch {
          // Swallowed: a denied or vanished directory just stays unread, and
          // attemptedUnread already keeps this session from retrying it.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEARCH_DEEPEN_CONCURRENCY, frontier.length) }, worker));
  } finally {
    settle();
    searchDeepen.disabled = false;
    // A read that lands after the dialog closed only warms the cache — no DOM to update.
    if (!lifecycle.signal.aborted && searchDialog.open) renderSearchResults(searchInput.value);
  }
}

function renderMatches(matches: SearchMatch[]): void {
  if (!matches.length) {
    searchResults.append(emptyResult("NO MATCHING OBJECTS"));
    setActiveResult(-1);
    return;
  }
  matches.forEach((match, index) => {
    const { node, trail } = match;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.id = `search-result-${index}`;
    button.role = "option";
    button.innerHTML = `<i class="result-glyph category-${categoryOf(node)}" aria-hidden="true"></i><span><strong></strong><small></small></span><kbd class="key-glyph">↵</kbd>`;
    const strong = button.querySelector("strong");
    if (strong) strong.textContent = node.name;
    const detail = button.querySelector("small");
    const measure = node.kind === "directory" ? `${node.children?.length ?? "?"} objects` : formatBytes(node.size);
    if (detail) {
      const elsewhere = trail[trail.length - 1].id !== currentDirectory().id;
      detail.textContent = elsewhere ? `${measure} · ${trail.map((part) => part.name).join("/")}` : measure;
    }
    button.addEventListener("click", () => void revealMatch(match), listener);
    // Keep pointer and keyboard on the same row, so there is only ever one highlight.
    button.addEventListener("pointerenter", () => setActiveResult(index), listener);
    item.append(button);
    searchResults.append(item);
    resultButtons.push(button);
  });
  setActiveResult(0);
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

function describeOutcome(outcome: SearchOutcome): string {
  const counted = `${outcome.complete ? "" : "over "}${outcome.total}`;
  const headline = outcome.total > outcome.matches.length
    ? `Showing ${outcome.matches.length} of ${counted}, refine to narrow`
    : `${counted} ${outcome.total === 1 ? "match" : "matches"}`;
  // Local directories load lazily, so say plainly which part of the tree was not looked at.
  return outcome.unreadDirectories > 0
    ? `${headline} · ${outcome.unreadDirectories} unopened ${outcome.unreadDirectories === 1 ? "directory" : "directories"} not indexed`
    : headline;
}

function emptyResult(message: string): HTMLLIElement {
  const empty = document.createElement("li");
  empty.className = "search-empty";
  empty.textContent = message;
  return empty;
}

/**
 * A result is a destination, not a highlight: picking one does what double-clicking the
 * object in the world would do. The directory holding it is travelled to first, since a
 * match from elsewhere in the tree has no district on screen to open anything in.
 *
 * That travel is awaited rather than fired off. Building a district takes the camera and
 * clears the selection, so a match framed before it lands is a match it un-frames.
 */
async function revealMatch(match: SearchMatch): Promise<void> {
  searchDialog.close();
  const destination = match.trail[match.trail.length - 1];
  if (destination.id !== currentDirectory().id) {
    const direction: NavigationDirection = match.trail.length > ancestry.length ? "forward" : "backward";
    ancestry = [...match.trail];
    await renderDirectory(true, direction);
  }
  // Frame it, then open it. What opening means is `openNode`'s question to answer, and a
  // directory answers it by flying into itself, which takes the camera off the approach.
  world.focusNode(match.node);
  await openNode(match.node);
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
searchDeepen.addEventListener("click", () => void deepenSearch(), listener);
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
scopeCurrentButton.addEventListener("click", () => {
  applySearchScope("current");
  searchInput.focus();
}, listener);
scopeAllButton.addEventListener("click", () => {
  applySearchScope("all");
  searchInput.focus();
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

sizeButtons.forEach((button) => button.addEventListener("click", () => chooseSize(button.dataset.lensSize === "total" ? "total" : "own"), listener));
colourButtons.forEach((button) => button.addEventListener("click", () => {
  const colour = button.dataset.lensColour;
  chooseColour(colour === "age" || colour === "git" ? colour : "type");
}, listener));
lensButton.addEventListener("click", () => setLensOpen(!lensOpen), listener);
// Touching the view is going back to it, so the folded panel gets out of the way.
canvas.addEventListener("pointerdown", () => lensOpen && setLensOpen(false), listener);
applyColourLens();
void refreshGitStatus();

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && lensOpen && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    setLensOpen(false);
    lensButton.focus();
    return;
  }
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
    if (landing) ancestry = landing;
    await renderDirectory(false, "initial", "replace");
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
    document.documentElement.removeAttribute("data-selection");
    sourceTransition.invalidate();
    renderGeneration += 1;
    measuring?.abort();
    document.documentElement.removeAttribute("data-measuring");
    document.documentElement.removeAttribute("data-lens-open");
    viewer.destroy();
    world.destroy();
    destroyPromise = sourceTransition.dispose(filesystem);
    return destroyPromise;
  },
};
}
