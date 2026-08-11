import { el } from "./dom";
import { textDocument } from "./text";
import type { ViewerHost } from "./types";

/** Nodes rendered before the tree stops expanding; a source map would otherwise hang the pane. */
const MAX_NODES = 20_000;
/** Levels open on arrival — deep enough to show shape, shallow enough to stay readable. */
const OPEN_DEPTH = 2;
/** Recursion guard: hand-written JSON never nests this far, generated JSON sometimes does. */
const MAX_DEPTH = 64;

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("STRUCTURED DATA / JSON");
  const value = await host.text();
  if (host.signal.aborted) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    host.setMode("STRUCTURED DATA / MALFORMED");
    host.mount(textDocument(value));
    host.setStatus(`PARSE FAILED / ${error instanceof Error ? error.message.toUpperCase() : "SHOWN AS TEXT"}`);
    return;
  }

  const budget = { left: MAX_NODES };
  const tree = el("div", "json-view");
  tree.append(branch(parsed, null, 0, budget));

  host.mount(tree);
  host.addToggle({
    label: (on) => `VIEW: ${on ? "TREE" : "RAW"}`,
    initial: true,
    onChange: (on) => host.mount(on ? tree : textDocument(value)),
  });

  const counts = summarise(parsed);
  host.setStatus(`${counts} / ${budget.left > 0 ? "COMPLETE" : `FIRST ${MAX_NODES} NODES`}`);
}

function branch(value: unknown, key: string | null, depth: number, budget: { left: number }): HTMLElement {
  budget.left -= 1;
  if (budget.left <= 0) return el("div", "json-row", "…");

  if (value === null || typeof value !== "object") return leaf(key, value);
  if (depth >= MAX_DEPTH) return el("div", "json-row", "… nested beyond the display depth");

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const isArray = Array.isArray(value);

  const details = el("details", "json-branch");
  details.open = depth < OPEN_DEPTH;
  const summary = el("summary");
  if (key !== null) summary.append(el("span", "json-key", key));
  summary.append(el("span", "json-brace", isArray ? `[ ${entries.length} ]` : `{ ${entries.length} }`));
  details.append(summary);

  const children = el("div", "json-children");
  for (const [childKey, childValue] of entries) {
    children.append(branch(childValue, childKey, depth + 1, budget));
    if (budget.left <= 0) break;
  }
  details.append(children);
  return details;
}

function leaf(key: string | null, value: unknown): HTMLElement {
  const row = el("div", "json-row");
  if (key !== null) row.append(el("span", "json-key", key));
  const type = value === null ? "null" : typeof value;
  row.append(el("span", `json-value is-${type}`, value === null ? "null" : typeof value === "string" ? `"${value}"` : String(value)));
  return row;
}

function summarise(value: unknown): string {
  if (Array.isArray(value)) return `ARRAY / ${value.length} ENTRIES`;
  if (value && typeof value === "object") return `OBJECT / ${Object.keys(value).length} KEYS`;
  return `${(value === null ? "null" : typeof value).toUpperCase()} LITERAL`;
}
