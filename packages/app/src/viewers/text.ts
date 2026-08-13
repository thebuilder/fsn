import { formatBytes } from "@fsn/core";
import { el } from "./dom";
import { decodeTextDocument, isStrictUtf8, serializeTextDocument } from "./text-codec";
import type { Action, ViewerHost } from "./types";

const MAX_TEXT_BYTES = 2_000_000;

/** The line-numbered SimpleText pane, shared with the JSON viewer's raw mode. */
export function textDocument(value: string): HTMLElement {
  const wrapper = el("div", "text-document");
  const gutter = el("ol", "line-numbers");
  const pre = el("pre");
  pre.tabIndex = 0;
  pre.append(el("code", undefined, value));
  for (let index = value.split("\n").length; index > 0; index -= 1) gutter.append(el("li"));
  wrapper.append(gutter, pre);
  return wrapper;
}

export async function render(host: ViewerHost): Promise<void> {
  if ((host.node.size ?? 0) > MAX_TEXT_BYTES) {
    throw new Error(`Object exceeds the ${formatBytes(MAX_TEXT_BYTES)} terminal buffer.`);
  }
  const source = await host.blob();
  if (source.size > MAX_TEXT_BYTES) {
    throw new Error(`Object exceeds the ${formatBytes(MAX_TEXT_BYTES)} terminal buffer.`);
  }
  if (!host.writeText) {
    // Read-only platforms historically displayed malformed or legacy text with
    // replacement characters. Strict UTF-8 is reserved for the writable path,
    // where silently replacing bytes would make a save destructive.
    const value = await source.text();
    if (host.signal.aborted) return;
    renderReadOnly(host, value);
    return;
  }

  const bytes = new Uint8Array(await source.arrayBuffer());
  if (host.signal.aborted) return;
  if (!isStrictUtf8(bytes)) {
    // The platform may only learn the encoding at read time (e.g. a native read
    // that tolerated non-UTF-8 bytes rather than failing), so the viewer re-checks
    // here and falls back to the same read-only presentation used above.
    const value = new TextDecoder("utf-8").decode(bytes);
    renderReadOnly(host, value);
    return;
  }

  const document = decodeTextDocument(bytes);
  const value = document.value;

  host.setMode("SIMPLETEXT / EDITABLE UTF-8");
  const editor = editableTextDocument(value, host.node.name);
  let savedCanonicalValue = value;
  let saveAction: Action;

  const paintState = (): void => {
    const dirty = editor.input.value !== savedCanonicalValue;
    saveAction.setDisabled(!dirty);
    saveAction.setLabel(dirty ? "SAVE CHANGES" : "SAVED");
    host.setDiscardGuard(
      dirty
        ? () => window.confirm(`Discard unsaved changes to ${host.node.name}?`)
        : null,
    );
    host.setStatus(`${describeText(editor.input.value)}${dirty ? " / UNSAVED" : " / SAVED"}`);
  };

  saveAction = host.addAction({
    label: "SAVED",
    title: "Save this UTF-8 text file",
    onActivate: async () => {
      // The textarea remains editable while native I/O is in flight. Capture the
      // exact revision submitted so later keystrokes stay dirty after it completes.
      const valueToSave = editor.input.value;
      const serialized = serializeTextDocument(valueToSave, document);
      let result = await host.writeText!(serialized);
      if (result.status === "conflict") {
        const overwrite = window.confirm(
          `${host.node.name} changed outside FSN. Overwrite the newer file with these edits?`,
        );
        if (!overwrite) {
          host.setStatus("SAVE CANCELLED / FILE CHANGED ON DISK");
          return;
        }
        result = await host.writeText!(serialized, { force: true });
      }
      if (result.status !== "saved") return;
      savedCanonicalValue = valueToSave;
      host.node.size = result.size;
      host.node.modified = result.modified;
      paintState();
    },
  });

  editor.input.addEventListener("input", paintState);
  host.onCleanup(() => host.setDiscardGuard(null));
  host.mount(editor.root);
  paintState();
  editor.input.focus({ preventScroll: true });
}

/** Shared presentation for text that will not be re-serialized: plain view, no save action. */
function renderReadOnly(host: ViewerHost, value: string): void {
  host.setMode("SIMPLETEXT / READ ONLY");
  host.mount(textDocument(value));
  host.setStatus(describeText(value));
}

function editableTextDocument(value: string, name: string): { root: HTMLElement; input: HTMLTextAreaElement } {
  const root = el("div", "text-editor");
  const gutter = el("ol", "line-numbers");
  const input = el("textarea", "text-editor-input");
  input.value = value;
  input.ariaLabel = `Edit ${name}`;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.wrap = "off";

  const paintLines = (): void => {
    const count = input.value.split("\n").length;
    gutter.replaceChildren(...Array.from({ length: count }, () => el("li")));
    gutter.scrollTop = input.scrollTop;
  };
  input.addEventListener("input", paintLines);
  input.addEventListener("scroll", () => {
    gutter.scrollTop = input.scrollTop;
  });
  paintLines();
  root.append(gutter, input);
  return { root, input };
}

function describeText(value: string): string {
  return `${value.split("\n").length} LINES / ${value.length} CHARS`;
}
