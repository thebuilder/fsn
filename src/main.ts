import { inject } from "@vercel/analytics";
import { createDemoFilesystem } from "./demo";
import {
  categoryOf,
  ensureChildren,
  formatBytes,
  formatDate,
  openBrowserDirectory,
  pathFor,
  rootFromFileList,
  searchFilesystem,
  sortNodes,
  type FilesystemRoot,
  type FsNode,
  type SearchMatch,
  type SearchOutcome,
} from "./filesystem";
import { WorldScene, type NavigationDirection } from "./scene";
import { FileViewer } from "./viewer";

/**
 * Vercel Web Analytics. Runs once, client-side, before anything else mounts.
 *
 * The mode is pinned to Vite's own build flag rather than left on `auto`, which
 * sniffs `process.env.NODE_ENV`, a variable the browser bundle only happens to
 * carry. In development this logs events to the console instead of requesting
 * `/_vercel/insights/*`, which only exists on a Vercel deployment.
 */
inject({ mode: import.meta.env.PROD ? "production" : "development" });

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
const status = getElement<HTMLElement>("status");
const folderButton = getElement<HTMLButtonElement>("folder-button");
const folderFallback = getElement<HTMLInputElement>("folder-fallback");
const demoButton = getElement<HTMLButtonElement>("demo-button");
const searchButton = getElement<HTMLButtonElement>("search-button");
const searchDialog = getElement<HTMLDialogElement>("search-dialog");
const searchInput = getElement<HTMLInputElement>("search-input");
const searchResults = getElement<HTMLUListElement>("search-results");
const searchCount = getElement<HTMLElement>("search-count");
const scopeSwitch = getElement<HTMLElement>("scope-switch");
const scopeCurrentButton = getElement<HTMLButtonElement>("scope-current");
const scopeAllButton = getElement<HTMLButtonElement>("scope-all");
const welcomeDialog = getElement<HTMLDialogElement>("welcome-dialog");

const viewer = new FileViewer({
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
  close: getElement<HTMLButtonElement>("viewer-close"),
});

let filesystem: FilesystemRoot = createDemoFilesystem();
let ancestry: FsNode[] = [filesystem.root];
let selectedNode: FsNode | null = null;

const world = new WorldScene(canvas, {
  onSelect: updateSelection,
  onOpen: (node) => void openNode(node),
  onHover: updateHover,
  onAim: updateAim,
  onKeyboardNavigation: (active) => reticle.classList.toggle("is-keyboard-active", active),
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

/** Updates every panel outside the 3D view. Never touches the camera. */
function renderChrome(): void {
  const current = currentDirectory();
  const children = currentChildren();
  ancestryById.set(current.id, [...ancestry]);
  sourceLabel.textContent = filesystem.sourceLabel;
  directoryTitle.textContent = current.name;
  const directories = children.filter((node) => node.kind === "directory").length;
  const files = children.length - directories;
  directorySummary.textContent = `${children.length} objects · ${directories} ${directories === 1 ? "directory" : "directories"} · ${files} ${files === 1 ? "file" : "files"}`;
  renderBreadcrumbs();
  if (renderedDirectoryId !== current.id) {
    renderedDirectoryId = current.id;
    restartTitleTransition();
  }
}

/** Replays the heading animation; the reflow is what lets it retrigger. */
function restartTitleTransition(): void {
  sceneTitle.classList.remove("is-entering");
  void sceneTitle.offsetWidth;
  sceneTitle.classList.add("is-entering");
}

function renderDirectory(announce = true, direction: NavigationDirection = "backward"): void {
  renderChrome();
  const current = currentDirectory();
  const children = currentChildren();
  world.setDirectory(current, children, direction);
  if (announce) setStatus(`${current.name} mounted · ${children.length} objects`);
}

/** The camera flew into an area we have already built; adopt it without moving. */
function adoptArea(directoryId: string): void {
  const trail = ancestryById.get(directoryId);
  if (!trail || trail[trail.length - 1].id === currentDirectory().id) return;
  ancestry = [...trail];
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
      renderDirectory(true, "backward");
    });
    // Animate crumbs that are genuinely new, plus the one that just became current
    // (so stepping back reads as a change rather than a silent restyle).
    if (!previousCrumbIds.includes(node.id) || (isLeaf && previousLeaf !== node.id)) {
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
    await viewer.open(node, pathFor(node, ancestry));
    return;
  }
  setStatus(`Scanning ${node.name}…`);
  try {
    await ensureChildren(node);
    ancestry.push(node);
    renderDirectory(true, "forward");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : `Unable to open ${node.name}`, true);
  }
}

function goBack(): void {
  if (ancestry.length <= 1) return;
  ancestry.pop();
  renderDirectory(true, "backward");
}

function goToRoot(): void {
  if (ancestry.length <= 1) {
    world.refocus();
    setStatus(`Recentred on ${currentDirectory().name}`);
    return;
  }
  ancestry = [ancestry[0]];
  renderDirectory(true, "backward");
}

function setFilesystem(next: FilesystemRoot): void {
  filesystem = next;
  ancestry = [next.root];
  ancestryById.clear();
  renderDirectory(true, "initial");
}

function setStatus(message: string, isError = false): void {
  status.classList.toggle("is-error", isError);
  const text = status.querySelector("span");
  if (text) text.textContent = message;
}

async function chooseFolder(): Promise<void> {
  setStatus("Awaiting directory authorization…");
  try {
    const selected = await openBrowserDirectory();
    if (selected) {
      setFilesystem(selected);
      welcomeDialog.close();
    } else {
      folderFallback.click();
      setStatus("Choose a directory snapshot");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setStatus("Folder selection cancelled");
      return;
    }
    setStatus(error instanceof Error ? error.message : "Folder access was denied", true);
  }
}

/** Results are capped so a broad query returns a readable list instead of the whole tree. */
const searchResultLimit = 25;
let searchScope: "current" | "all" = "current";
let resultButtons: HTMLButtonElement[] = [];
let activeResultIndex = -1;

function openSearch(): void {
  searchInput.value = "";
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
    button.innerHTML = `<i class="result-glyph category-${categoryOf(node)}" aria-hidden="true"></i><span><strong></strong><small></small></span><kbd>↵</kbd>`;
    const strong = button.querySelector("strong");
    if (strong) strong.textContent = node.name;
    const detail = button.querySelector("small");
    const measure = node.kind === "directory" ? `${node.children?.length ?? "?"} objects` : formatBytes(node.size);
    if (detail) {
      const elsewhere = trail[trail.length - 1].id !== currentDirectory().id;
      detail.textContent = elsewhere ? `${measure} · ${trail.map((part) => part.name).join("/")}` : measure;
    }
    button.addEventListener("click", () => revealMatch(match));
    // Keep pointer and keyboard on the same row, so there is only ever one highlight.
    button.addEventListener("pointerenter", () => setActiveResult(index));
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

/** Travels to the directory holding the match before framing it, so results outside the view still work. */
function revealMatch(match: SearchMatch): void {
  searchDialog.close();
  const destination = match.trail[match.trail.length - 1];
  if (destination.id !== currentDirectory().id) {
    const direction: NavigationDirection = match.trail.length > ancestry.length ? "forward" : "backward";
    ancestry = [...match.trail];
    renderDirectory(true, direction);
  }
  world.focusNode(match.node);
  updateSelection(match.node);
}

function trimName(name: string, length: number): string {
  return name.length > length ? `${name.slice(0, length - 1)}…` : name;
}

folderButton.addEventListener("click", () => void chooseFolder());
demoButton.addEventListener("click", () => setFilesystem(createDemoFilesystem()));
enterButton.addEventListener("click", () => selectedNode && void openNode(selectedNode));
searchButton.addEventListener("click", openSearch);
searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
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
    const active = resultButtons[activeResultIndex];
    if (!active) return;
    event.preventDefault();
    active.click();
  }
});
scopeCurrentButton.addEventListener("click", () => {
  applySearchScope("current");
  searchInput.focus();
});
scopeAllButton.addEventListener("click", () => {
  applySearchScope("all");
  searchInput.focus();
});
folderFallback.addEventListener("change", () => {
  if (!folderFallback.files) return;
  const imported = rootFromFileList(folderFallback.files);
  if (imported) setFilesystem(imported);
  welcomeDialog.close();
  folderFallback.value = "";
});
getElement<HTMLAnchorElement>("brand-home").addEventListener("click", (event) => {
  event.preventDefault();
  goToRoot();
});
getElement<HTMLButtonElement>("welcome-demo").addEventListener("click", () => welcomeDialog.close());
getElement<HTMLButtonElement>("welcome-folder").addEventListener("click", () => void chooseFolder());

window.addEventListener("keydown", (event) => {
  // Camera movement keys are owned by WorldScene; it reports back via onKeyboardNavigation.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!searchDialog.open) openSearch();
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
});

window.addEventListener("pointerdown", (event) => {
  if (event.button === 0) world.setKeyboardNavigationActive(false);
});

renderDirectory(false, "initial");
welcomeDialog.showModal();
