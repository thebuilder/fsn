import { createDemoFilesystem } from "./demo";
import {
  categoryOf,
  ensureChildren,
  formatBytes,
  formatDate,
  openBrowserDirectory,
  pathFor,
  rootFromFileList,
  sortNodes,
  type FilesystemRoot,
  type FsNode,
} from "./filesystem";
import { WorldScene, type NavigationDirection } from "./scene";
import { FileViewer } from "./viewer";

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
}

const canvas = getElement<HTMLCanvasElement>("world");
const breadcrumbs = getElement<HTMLElement>("breadcrumbs");
const sourceLabel = getElement<HTMLElement>("source-label");
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
const welcomeDialog = getElement<HTMLDialogElement>("welcome-dialog");

const viewer = new FileViewer({
  dialog: getElement<HTMLDialogElement>("file-viewer"),
  title: getElement("viewer-title"),
  mode: getElement("viewer-mode"),
  path: getElement("viewer-path"),
  size: getElement("viewer-size"),
  content: getElement("viewer-content"),
  position: getElement("viewer-position"),
  pixelToggle: getElement<HTMLButtonElement>("pixel-toggle"),
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
});

function currentDirectory(): FsNode {
  return ancestry[ancestry.length - 1];
}

function currentChildren(): FsNode[] {
  return sortNodes(currentDirectory().children ?? []);
}

function renderDirectory(announce = true, direction: NavigationDirection = "backward"): void {
  const current = currentDirectory();
  const children = currentChildren();
  sourceLabel.textContent = filesystem.sourceLabel;
  directoryTitle.textContent = current.name;
  const directories = children.filter((node) => node.kind === "directory").length;
  const files = children.length - directories;
  directorySummary.textContent = `${children.length} objects · ${directories} ${directories === 1 ? "directory" : "directories"} · ${files} ${files === 1 ? "file" : "files"}`;
  renderBreadcrumbs();
  world.setDirectory(current, children, direction);
  if (announce) setStatus(`${current.name} mounted · ${children.length} objects`);
}

function renderBreadcrumbs(): void {
  breadcrumbs.replaceChildren();
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
    button.ariaCurrent = index === ancestry.length - 1 ? "page" : "false";
    button.addEventListener("click", () => {
      ancestry = ancestry.slice(0, index + 1);
      renderDirectory(true, "backward");
    });
    breadcrumbs.append(button);
  });
}

function updateSelection(node: FsNode | null): void {
  selectedNode = node;
  if (!node) {
    detailsKind.textContent = "NO SELECTION";
    detailsTitle.textContent = "Select an object";
    detailsGlyph.className = "file-glyph";
    detailsList.innerHTML = `<div><dt>Path</dt><dd>—</dd></div><div><dt>Size</dt><dd>—</dd></div><div><dt>Modified</dt><dd>—</dd></div>`;
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

function setFilesystem(next: FilesystemRoot): void {
  filesystem = next;
  ancestry = [next.root];
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

function openSearch(): void {
  searchInput.value = "";
  renderSearchResults("");
  searchDialog.showModal();
  searchInput.focus();
}

function renderSearchResults(query: string): void {
  const normalized = query.trim().toLowerCase();
  const nodes = currentChildren().filter((node) => !normalized || node.name.toLowerCase().includes(normalized)).slice(0, 12);
  searchResults.replaceChildren();
  if (!nodes.length) {
    const empty = document.createElement("li");
    empty.className = "search-empty";
    empty.textContent = "NO MATCHING OBJECTS";
    searchResults.append(empty);
    return;
  }
  nodes.forEach((node) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<i class="result-glyph category-${categoryOf(node)}" aria-hidden="true"></i><span><strong></strong><small>${node.kind === "directory" ? `${node.children?.length ?? "?"} objects` : formatBytes(node.size)}</small></span><kbd>↵</kbd>`;
    const strong = button.querySelector("strong");
    if (strong) strong.textContent = node.name;
    button.addEventListener("click", () => {
      searchDialog.close();
      world.focusNode(node);
      updateSelection(node);
    });
    item.append(button);
    searchResults.append(item);
  });
}

function trimName(name: string, length: number): string {
  return name.length > length ? `${name.slice(0, length - 1)}…` : name;
}

folderButton.addEventListener("click", () => void chooseFolder());
demoButton.addEventListener("click", () => setFilesystem(createDemoFilesystem()));
enterButton.addEventListener("click", () => selectedNode && void openNode(selectedNode));
searchButton.addEventListener("click", openSearch);
searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
folderFallback.addEventListener("change", () => {
  if (!folderFallback.files) return;
  const imported = rootFromFileList(folderFallback.files);
  if (imported) setFilesystem(imported);
  welcomeDialog.close();
  folderFallback.value = "";
});
getElement<HTMLButtonElement>("welcome-demo").addEventListener("click", () => welcomeDialog.close());
getElement<HTMLButtonElement>("welcome-folder").addEventListener("click", () => void chooseFolder());

window.addEventListener("keydown", (event) => {
  const isCameraNavigationKey = ["w", "a", "s", "d"].includes(event.key.toLowerCase()) || event.key.startsWith("Arrow");
  if (isCameraNavigationKey && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLButtonElement)) {
    reticle.classList.add("is-keyboard-active");
    world.setKeyboardNavigationActive(true);
  }
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
  if (event.button === 0) {
    reticle.classList.remove("is-keyboard-active");
    world.setKeyboardNavigationActive(false);
  }
});

renderDirectory(false, "initial");
welcomeDialog.showModal();
