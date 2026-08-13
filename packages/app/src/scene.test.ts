import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { labelScaleFor, turnTarget } from "./scene";

const MAX_POLAR = Math.PI * 0.49;

/** Where the camera is looking, which is the only thing a turn is meant to change. */
function viewDirection(camera: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3().subVectors(target, camera).normalize();
}

describe("turnTarget", () => {
  // Looking down -Z from above, so left is -X and right is +X.
  const camera = () => new THREE.Vector3(0, 10, 10);
  const target = () => new THREE.Vector3(0, 0, 0);

  it("keeps the camera where it is and swings the view left", () => {
    const camPos = camera();
    const result = turnTarget(camPos, target(), 0.4, 0, 0, MAX_POLAR);
    expect(viewDirection(camPos, result).x).toBeLessThan(0);
    expect(camPos.toArray()).toEqual([0, 10, 10]);
  });

  it("swings the view right on a negative yaw", () => {
    const camPos = camera();
    const result = turnTarget(camPos, target(), -0.4, 0, 0, MAX_POLAR);
    expect(viewDirection(camPos, result).x).toBeGreaterThan(0);
  });

  it("holds the distance to the target across a turn", () => {
    const camPos = camera();
    const before = camPos.distanceTo(target());
    const result = turnTarget(camPos, target(), 0.4, 0.2, 0, MAX_POLAR);
    expect(camPos.distanceTo(result)).toBeCloseTo(before, 6);
  });

  it("tilts the view up on a positive pitch and down on a negative one", () => {
    const camPos = camera();
    const level = viewDirection(camPos, target()).y;
    expect(viewDirection(camPos, turnTarget(camera(), target(), 0, 0.2, 0, MAX_POLAR)).y).toBeGreaterThan(level);
    expect(viewDirection(camPos, turnTarget(camera(), target(), 0, -0.2, 0, MAX_POLAR)).y).toBeLessThan(level);
  });

  it("stops the tilt at the horizon rather than rolling over the top", () => {
    const camPos = camera();
    let result = target();
    for (let i = 0; i < 200; i += 1) result = turnTarget(camPos, result, 0, 0.05, 0, MAX_POLAR);
    const direction = viewDirection(camPos, result);
    // Just below level: the controls never let the target rise past the camera.
    expect(direction.y).toBeLessThan(0);
    expect(direction.y).toBeGreaterThan(-0.1);
  });

  it("stops the tilt short of straight down, where a turn has no heading left", () => {
    const camPos = camera();
    let result = target();
    for (let i = 0; i < 200; i += 1) result = turnTarget(camPos, result, 0, -0.05, 0, MAX_POLAR);
    const direction = viewDirection(camPos, result);
    expect(direction.y).toBeLessThan(-0.999);
    expect(direction.y).toBeGreaterThan(-1);
  });
});

/** Apparent size on screen: a plate's drawn size divided by how far away it is. */
function apparentSize(distance: number): number {
  return labelScaleFor(distance) / distance;
}

describe("labelScaleFor", () => {
  it("leaves a plate at its drawn size until reading it becomes hard", () => {
    expect(labelScaleFor(4)).toBe(1);
    expect(labelScaleFor(26)).toBe(1);
  });

  it("gives a distant plate back most of the pixels perspective took", () => {
    // Without growth a plate at 120 would be under a quarter the size of one at 26.
    expect(apparentSize(120) / apparentSize(26)).toBeGreaterThan(0.4);
  });

  it("still lets far read as far, so the skyline keeps its depth", () => {
    expect(apparentSize(120)).toBeLessThan(apparentSize(60));
    expect(apparentSize(60)).toBeLessThan(apparentSize(26));
  });

  it("caps the growth, so nothing past the far limit keeps swelling", () => {
    expect(labelScaleFor(150)).toBeCloseTo(2.4, 5);
    expect(labelScaleFor(400)).toBe(2.4);
  });

  it("grows smoothly, with no step at the distance it starts", () => {
    expect(labelScaleFor(26.001)).toBeCloseTo(1, 4);
  });
});
