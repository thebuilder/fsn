import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createScanCage, createScanUniforms, SCAN_DURATION, scanEnd, scanPose, solidReachesAt } from "./scan";

describe("scanPose", () => {
  const reach = 40;

  it("starts from nothing, with the cage not yet lit", () => {
    const pose = scanPose(0, reach);
    expect(pose.radius).toBe(0);
    expect(pose.wire).toBe(0);
    expect(pose.done).toBe(false);
  });

  it("only ever moves the front outwards", () => {
    let previous = -1;
    for (let elapsed = 0; elapsed <= SCAN_DURATION; elapsed += SCAN_DURATION / 50) {
      const { radius } = scanPose(elapsed, reach);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
  });

  it("holds the cage at full strength through the middle of the sweep", () => {
    expect(scanPose(SCAN_DURATION * 0.5, reach).wire).toBe(1);
  });

  it("ends with the solid front past the furthest corner and the cage gone", () => {
    const pose = scanPose(SCAN_DURATION, reach);
    expect(pose.done).toBe(true);
    expect(pose.wire).toBe(0);
    expect(pose.radius).toBe(scanEnd(reach));
    expect(pose.radius).toBeGreaterThan(solidReachesAt(reach, reach));
  });

  it("clamps a clock that runs past the end, as a held reveal released late can", () => {
    expect(scanPose(SCAN_DURATION * 4, reach)).toEqual(scanPose(SCAN_DURATION, reach));
  });

  it("takes the same time whatever the size of the district", () => {
    const small = scanPose(SCAN_DURATION * 0.4, 8);
    const large = scanPose(SCAN_DURATION * 0.4, 200);
    expect(small.radius / scanEnd(8)).toBeCloseTo(large.radius / scanEnd(200));
  });
});

describe("createScanCage", () => {
  it("draws the twelve edges of every box, in world space around each box", () => {
    const uniforms = createScanUniforms(new THREE.Vector3(), 10);
    const cage = createScanCage([
      { position: new THREE.Vector3(5, 1, 0), scale: new THREE.Vector3(2, 2, 2) },
      { position: new THREE.Vector3(-5, 3, 0), scale: new THREE.Vector3(1, 6, 1) },
    ], uniforms);
    const position = cage.geometry.getAttribute("position");
    expect(position.count).toBe(2 * 12 * 2);

    const bounds = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
    expect(bounds.min.x).toBeCloseTo(-5.5, 1);
    expect(bounds.max.x).toBeCloseTo(6, 1);
    expect(bounds.max.y).toBeCloseTo(6, 1);
    cage.geometry.dispose();
    (cage.material as THREE.Material).dispose();
  });
});
