import { describe, expect, it } from "vitest";
import { hasBytes, type FsNode, type FsResource } from "@fsn/core";
import { createDemoFilesystem, GENERATED_SIZES, type DemoResourceFactory } from "./demo";
import { rendererFor } from "./viewers/registry";

function collectResourceIds(node: FsNode): string[] {
  return [
    ...(node.resource ? [node.resource.id] : []),
    ...(node.children ?? []).flatMap(collectResourceIds),
  ];
}

function files(node: FsNode, path = ""): Array<{ node: FsNode; path: string }> {
  const here = `${path}/${node.name}`;
  if (node.kind === "file") return [{ node, path: here }];
  return (node.children ?? []).flatMap((child) => files(child, here));
}

function directories(node: FsNode): FsNode[] {
  return node.kind === "directory" ? [node, ...(node.children ?? []).flatMap(directories)] : [];
}

/** Records what each resource was registered as, so a test can read it back like an adapter. */
function recordingFactory() {
  const reads = new Map<string, () => Promise<Blob>>();
  const resource = (id: string): FsResource => ({ id, readable: true });
  const factory: DemoResourceFactory = {
    text: (id) => resource(id),
    url: (id) => resource(id),
    bytes: (id, read) => {
      reads.set(id, read);
      return resource(id);
    },
  };
  return { factory, reads };
}

/**
 * The objects the demo refuses on purpose: applications, system files and the
 * mysteries. They carry bytes, so the refusal offers a hex dump instead of a blank.
 */
const LOCKED = new Set([
  "HyperCard.app", "MacPaint.app", "Netscape Navigator.app", "SimpleText.app", "System Profiler.app",
  "classified.dat", "telemetry.bin", "guestbook.db", "unknown.pkg",
  "AppleScript", "QuickTime™", "Sound Manager", "Geneva", "Finder Preferences", "System", "Finder",
]);

describe("demo filesystem", () => {
  it("gives replacement demo instances distinct resource IDs", () => {
    const { factory } = recordingFactory();

    const first = new Set(collectResourceIds(createDemoFilesystem(factory).root));
    const second = collectResourceIds(createDemoFilesystem(factory).root);

    expect(first.size).toBeGreaterThan(0);
    expect(second.every((id) => !first.has(id))).toBe(true);
  });

  it("puts bytes behind every file, so nothing is a catalogue entry only", () => {
    const { factory } = recordingFactory();
    const missing = files(createDemoFilesystem(factory).root).filter(({ node }) => !hasBytes(node));

    expect(missing.map(({ path }) => path)).toEqual([]);
  });

  it("opens every file in a real viewer except the ones locked on purpose", () => {
    const { factory } = recordingFactory();
    const all = files(createDemoFilesystem(factory).root);
    const denied = all.filter(({ node }) => rendererFor(node).id === "denied").map(({ node }) => node.name);

    expect(new Set(denied)).toEqual(LOCKED);
  });

  it("keeps text a viewer reads whole under the viewer's two-megabyte buffer", () => {
    const { factory } = recordingFactory();
    const textual = files(createDemoFilesystem(factory).root)
      .filter(({ node }) => ["text", "json", "table"].includes(rendererFor(node).id));

    expect(textual.length).toBeGreaterThan(40);
    expect(textual.filter(({ node }) => (node.size ?? 0) > 2_000_000).map(({ path }) => path)).toEqual([]);
  });

  it("keeps every district small enough to read as one city block", () => {
    const { factory } = recordingFactory();
    const crowded = directories(createDemoFilesystem(factory).root).filter((node) => (node.children?.length ?? 0) > 40);

    expect(crowded.map((node) => node.name)).toEqual([]);
  });

  it("generates each binary once, on first read, and agrees with the size it advertises", async () => {
    const { factory, reads } = recordingFactory();
    const root = createDemoFilesystem(factory).root;
    const byName = new Map(files(root).map(({ node }) => [node.name, node]));
    const blobFor = (name: string): Promise<Blob> => reads.get(byName.get(name)!.resource!.id)!();

    const first = await blobFor("manual.pdf");
    expect(await blobFor("manual.pdf")).toBe(first);
    expect(first.type).toBe("application/pdf");

    const advertised: Array<[string, keyof typeof GENERATED_SIZES]> = [
      ["contact-sheet.png", "contactSheet"],
      ["build-output.zip", "buildOutput"],
      ["guestbook.db", "guestbook"],
      ["ambient-loop.wav", "ambientLoop"],
      ["voice-memo.wav", "modemHandshake"],
      ["archive-001.zip", "archive"],
      ["manual.pdf", "manual"],
    ];
    for (const [name, key] of advertised) {
      const blob = await blobFor(name);
      expect({ name, size: blob.size }).toEqual({ name, size: GENERATED_SIZES[key] });
      expect(byName.get(name)!.size).toBe(blob.size);
    }
  });

  it("types generated media so the browser's own players accept it", async () => {
    const { factory, reads } = recordingFactory();
    const byName = new Map(files(createDemoFilesystem(factory).root).map(({ node }) => [node.name, node]));
    const typeOf = async (name: string): Promise<string> => (await reads.get(byName.get(name)!.resource!.id)!()).type;

    expect(await typeOf("voice-memo.wav")).toBe("audio/wav");
    expect(await typeOf("contact-sheet.png")).toBe("image/png");
  });
});
