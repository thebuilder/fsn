import { describe, expect, it } from "vitest";
import { readRoute, routeFor, sameRoute } from "./route";

describe("routeFor", () => {
  it("writes a path-shaped fragment from the root down", () => {
    expect(routeFor(["Macintosh HD", "Documents", "Field Notes"])).toBe("#/Macintosh%20HD/Documents/Field%20Notes");
  });

  it("addresses the root of a source with a bare slash", () => {
    expect(routeFor([])).toBe("#/");
  });

  it("escapes the separator, so a name containing one cannot invent a level", () => {
    expect(readRoute(routeFor(["disk", "a/b"]))).toEqual(["disk", "a/b"]);
  });
});

describe("readRoute", () => {
  it("reads back what it wrote", () => {
    const names = ["Macintosh HD", "Documents", "Field Notes"];
    expect(readRoute(routeFor(names))).toEqual(names);
  });

  it("addresses nothing when there is no fragment", () => {
    expect(readRoute("")).toEqual([]);
    expect(readRoute("#")).toEqual([]);
    expect(readRoute("#/")).toEqual([]);
  });

  it("ignores empty and trailing segments a hand-edited address can leave behind", () => {
    expect(readRoute("#//disk//Documents/")).toEqual(["disk", "Documents"]);
  });

  it("takes an undecodable segment literally rather than throwing", () => {
    expect(readRoute("#/disk/100%")).toEqual(["disk", "100%"]);
  });
});

describe("sameRoute", () => {
  it("distinguishes a shorter chain from a prefix of a longer one", () => {
    expect(sameRoute(["disk"], ["disk", "Documents"])).toBe(false);
    expect(sameRoute(["disk", "Documents"], ["disk", "Documents"])).toBe(true);
    expect(sameRoute(["disk", "Documents"], ["disk", "Downloads"])).toBe(false);
  });
});
