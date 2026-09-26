import { describe, expect, it } from "vitest";
import { buildConduit, linkEnds, LinkNetwork, rectExit, type LinkFootprint } from "./links";

const plot: LinkFootprint = { x: 0, z: 0, halfWidth: 2, halfDepth: 1 };

describe("rectExit", () => {
  it("leaves through the side the ray points at", () => {
    const exit = rectExit(plot, 1, 0);
    expect(exit.x).toBeCloseTo(2);
    expect(exit.y).toBeCloseTo(0);
  });

  it("leaves through whichever pair of sides a diagonal reaches first", () => {
    // At 45 degrees a box twice as wide as it is deep is left through a long side.
    const exit = rectExit(plot, 1, 1);
    expect(exit.y).toBeCloseTo(1);
    expect(exit.x).toBeCloseTo(1);
  });

  it("stays at the centre when there is no direction to leave in", () => {
    const exit = rectExit({ x: 3, z: 4, halfWidth: 1, halfDepth: 1 }, 0, 0);
    expect(exit.x).toBe(3);
    expect(exit.y).toBe(4);
  });
});

describe("linkEnds", () => {
  it("runs from the plot's edge to the near edge of the district", () => {
    const district: LinkFootprint = { x: 30, z: 0, halfWidth: 10, halfDepth: 10 };
    const ends = linkEnds(plot, district);
    expect(ends).not.toBeNull();
    expect(ends?.start.x).toBeCloseTo(2);
    expect(ends?.end.x).toBeCloseTo(20);
    expect(ends?.length).toBeCloseTo(18);
  });

  it("works the same in any direction", () => {
    const district: LinkFootprint = { x: -24, z: -24, halfWidth: 6, halfDepth: 6 };
    const ends = linkEnds(plot, district);
    expect(ends?.end.x).toBeCloseTo(-18);
    expect(ends?.end.y).toBeCloseTo(-18);
    expect(ends?.start.y).toBeCloseTo(-1);
  });

  it("refuses to lay a wire between districts that overlap", () => {
    expect(linkEnds(plot, { x: 3, z: 0, halfWidth: 4, halfDepth: 4 })).toBeNull();
  });
});

describe("buildConduit", () => {
  it("measures distance from the parent end, so the pulse travels outwards", () => {
    const ends = linkEnds(plot, { x: 30, z: 0, halfWidth: 10, halfDepth: 10 });
    if (!ends) throw new Error("expected a link");
    const geometry = buildConduit(ends, 0);
    const position = geometry.getAttribute("position");
    const along = geometry.getAttribute("aAlong");
    for (let index = 0; index < along.count; index += 1) {
      // Every vertex's distance matches how far it actually is from the plot's edge.
      expect(position.getX(index) - ends.start.x).toBeCloseTo(along.getX(index));
    }
    expect(Math.max(...Array.from(along.array))).toBeCloseTo(18);
  });
});

describe("LinkNetwork", () => {
  const district: LinkFootprint = { x: 30, z: 0, halfWidth: 10, halfDepth: 10 };

  it("keeps one wire into each child, replacing it when relaid", () => {
    const network = new LinkNetwork();
    network.connect("root", "child", plot, district, 0);
    network.connect("root", "child", plot, district, 0);
    expect(network.group.children).toHaveLength(1);
  });

  it("drops a district's wires in and out when it is torn down", () => {
    const network = new LinkNetwork();
    network.connect("root", "child", plot, district, 0);
    network.connect("child", "grandchild", plot, { x: -30, z: 0, halfWidth: 5, halfDepth: 5 }, 0);
    network.connect("root", "sibling", plot, { x: 0, z: 30, halfWidth: 5, halfDepth: 5 }, 0);
    network.dropArea("child");
    expect(network.has("child")).toBe(false);
    expect(network.has("grandchild")).toBe(false);
    expect(network.has("sibling")).toBe(true);
    expect(network.group.children).toHaveLength(1);
  });

  it("lights a wire as brightly as its brighter end", () => {
    const network = new LinkNetwork();
    network.connect("root", "child", plot, district, 0, true);
    const material = network.group.children[0] as unknown as { material: { uniforms: { uOpacity: { value: number } } } };
    network.update(0.016, false, (id) => (id === "child" ? 1 : 0));
    expect(material.material.uniforms.uOpacity.value).toBe(1);
    network.update(0.016, false, () => 0);
    expect(material.material.uniforms.uOpacity.value).toBeLessThan(0.5);
  });

  it("does not lay a new wire while the reveal is parked", () => {
    const network = new LinkNetwork();
    network.connect("root", "child", plot, district, 0);
    const material = network.group.children[0] as unknown as { material: { uniforms: { uGrowth: { value: number } } } };
    network.update(0.5, true, () => 1);
    expect(material.material.uniforms.uGrowth.value).toBe(0);
    network.update(0.5, false, () => 1);
    expect(material.material.uniforms.uGrowth.value).toBeGreaterThan(0);
  });
});
