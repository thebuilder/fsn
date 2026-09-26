import { describe, expect, it } from "vitest";
import { readRoute, routeFor, sameObject, sameRoute, type RouteObject } from "./route";

describe("routeFor", () => {
  it("writes a path-shaped fragment from the root down", () => {
    expect(routeFor(["Macintosh HD", "Documents", "Field Notes"])).toBe("#/Macintosh%20HD/Documents/Field%20Notes");
  });

  it("addresses the root of a source with a bare slash", () => {
    expect(routeFor([])).toBe("#/");
  });

  it("escapes the separator, so a name containing one cannot invent a level", () => {
    expect(readRoute(routeFor(["disk", "a/b"])).names).toEqual(["disk", "a/b"]);
  });

  it("writes a selected object after the directory, and marks an open viewer", () => {
    expect(routeFor(["Macintosh HD", "Logs"], { name: "boot.log", viewing: false })).toBe("#/Macintosh%20HD/Logs?select=boot.log");
    expect(routeFor(["Macintosh HD", "Logs"], { name: "boot.log", viewing: true })).toBe("#/Macintosh%20HD/Logs?select=boot.log&view");
  });

  it("leaves the object off an address with no directory to hold it", () => {
    expect(routeFor([], { name: "a.txt", viewing: true })).toBe("#/");
  });

  it("does not throw on a name holding a lone surrogate", () => {
    const route = readRoute(routeFor(["disk", "bad\uD800name"], { name: "\uDC00", viewing: false }));
    expect(route).toEqual({ names: ["disk", "bad�name"], object: { name: "�", viewing: false } });
  });
});

describe("readRoute", () => {
  it("reads back what it wrote", () => {
    const names = ["Macintosh HD", "Documents", "Field Notes"];
    expect(readRoute(routeFor(names))).toEqual({ names, object: null });
  });

  it("addresses nothing when there is no fragment", () => {
    expect(readRoute("")).toEqual({ names: [], object: null });
    expect(readRoute("#")).toEqual({ names: [], object: null });
    expect(readRoute("#/")).toEqual({ names: [], object: null });
  });

  it("ignores empty and trailing segments a hand-edited address can leave behind", () => {
    expect(readRoute("#//disk//Documents/").names).toEqual(["disk", "Documents"]);
    expect(readRoute("#//disk//Documents/?select=a.txt")).toEqual({ names: ["disk", "Documents"], object: { name: "a.txt", viewing: false } });
  });

  it("takes an undecodable segment literally rather than throwing", () => {
    expect(readRoute("#/disk/100%").names).toEqual(["disk", "100%"]);
    expect(readRoute("#/disk?select=100%&view").object).toEqual({ name: "100%", viewing: true });
  });

  it("still reads every fragment written before objects could be addressed", () => {
    expect(readRoute("#/Macintosh%20HD/Documents/Field%20Notes")).toEqual({
      names: ["Macintosh HD", "Documents", "Field Notes"],
      object: null,
    });
    // A stray `?` typed by hand was always part of the name, and still is.
    expect(readRoute("#/disk/What?").names).toEqual(["disk", "What?"]);
    expect(readRoute("#/disk/a?b=c").names).toEqual(["disk", "a?b=c"]);
  });

  it("ignores a selection with no name and flags it does not know", () => {
    expect(readRoute("#/disk?select=")).toEqual({ names: ["disk"], object: null });
    expect(readRoute("#/disk?select=&view")).toEqual({ names: ["disk"], object: null });
    expect(readRoute("#/disk?select=a.txt&later&view")).toEqual({ names: ["disk"], object: { name: "a.txt", viewing: true } });
  });

  it("does not address an object outside any directory", () => {
    expect(readRoute("#?select=a.txt")).toEqual({ names: [], object: null });
  });
});

describe("route round trips", () => {
  const odd = [
    "Macintosh HD",
    "#hash",
    "100% done",
    "a/b",
    "%2F",
    "café",
    "Café",
    "日本語のフォルダ",
    "🛰️ uplink",
    "?select=decoy",
    "&view",
    "select=x&view",
    "a?select=b&view",
    "name with trailing space ",
    "+plus+",
    "..",
  ];

  it.each(odd)("keeps the directory name %j intact", (name) => {
    const names = ["disk", name, "inner"];
    expect(readRoute(routeFor(names))).toEqual({ names, object: null });
  });

  it.each(odd)("keeps the object name %j intact, viewer open or not", (name) => {
    for (const viewing of [false, true]) {
      const object: RouteObject = { name, viewing };
      expect(readRoute(routeFor(["disk", name], object))).toEqual({ names: ["disk", name], object });
    }
  });

  it("survives the browser handing back the fragment through a URL", () => {
    const object: RouteObject = { name: "?select=x&view #1", viewing: true };
    const url = new URL(`https://fsn.example/${routeFor(["Macintosh HD", "日本"], object)}`);
    expect(readRoute(url.hash)).toEqual({ names: ["Macintosh HD", "日本"], object });
  });
});

describe("sameRoute", () => {
  it("distinguishes a shorter chain from a prefix of a longer one", () => {
    expect(sameRoute(["disk"], ["disk", "Documents"])).toBe(false);
    expect(sameRoute(["disk", "Documents"], ["disk", "Documents"])).toBe(true);
    expect(sameRoute(["disk", "Documents"], ["disk", "Downloads"])).toBe(false);
  });
});

describe("sameObject", () => {
  it("tells an open viewer apart from a bare selection of the same object", () => {
    expect(sameObject({ name: "a", viewing: false }, { name: "a", viewing: false })).toBe(true);
    expect(sameObject({ name: "a", viewing: false }, { name: "a", viewing: true })).toBe(false);
    expect(sameObject(null, { name: "a", viewing: false })).toBe(false);
    expect(sameObject(null, null)).toBe(true);
  });
});
