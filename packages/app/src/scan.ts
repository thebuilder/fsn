import * as THREE from "three";

/**
 * The establishing shot's wireframe scan: a sphere grows out of the district's centre,
 * a phosphor cage of every object's edges rides its front, and the solid city fills in
 * a deliberate distance behind it. The cage is the survey and the solid is what the
 * survey found, so the order is the point: first the lines, then the matter, then the
 * lines let go.
 *
 * Everything here is measured against the district's `reach` (how far the furthest
 * corner of its skyline is from the centre), not in world units, so a two-file folder
 * and a two-hundred-file folder take the same time and read the same way.
 */

/** Long enough to be seen under the establishing flight, which lands at 2600 ms. */
export const SCAN_DURATION = 3000;
/** How far the solid trails the wire front, as a fraction of reach. */
const SCAN_LAG = 0.3;
/** Width of the bright band just behind each front. */
const SCAN_RIM = 0.08;
/** How long the cage lingers behind its front before it has faded to nothing. */
const SCAN_TRAIL = 0.55;
/** Amplitude of the front's ripple, so it reads as a scan and not a clipping sphere. */
const SCAN_WOBBLE = 0.045;
/** The cage appears over the first 6% of the timeline and dissipates over the last 28%. */
const WIRE_IN = 0.06;
const WIRE_OUT = 0.28;

export const SCAN_COLOR = 0x72f7d4;

export type ScanUniforms = {
  uScanOrigin: THREE.IUniform<THREE.Vector3>;
  uScanRadius: THREE.IUniform<number>;
  uScanEnabled: THREE.IUniform<number>;
  uScanLag: THREE.IUniform<number>;
  uScanRim: THREE.IUniform<number>;
  uScanTrail: THREE.IUniform<number>;
  uScanWobble: THREE.IUniform<number>;
  uScanColor: THREE.IUniform<THREE.Color>;
  uWireOpacity: THREE.IUniform<number>;
};

export type ScanPose = { radius: number; wire: number; done: boolean };

/**
 * Where the front is and how visible the cage is at `elapsed` ms. The radius eases out
 * so the scan leaves the centre fast and settles as it reaches the edges, and it ends
 * far enough out that the lagging, rippling solid front has cleared every corner.
 */
export function scanPose(elapsed: number, reach: number, duration = SCAN_DURATION): ScanPose {
  const progress = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 1.35);
  const radius = eased * scanEnd(reach);
  const fadeIn = THREE.MathUtils.clamp(progress / WIRE_IN, 0, 1);
  const fadeOut = THREE.MathUtils.clamp((1 - progress) / WIRE_OUT, 0, 1);
  return { radius, wire: Math.min(fadeIn, fadeOut), done: progress >= 1 };
}

/** The radius at which the solid front, lag and ripple included, has passed everything. */
export function scanEnd(reach: number): number {
  return reach * (1 + SCAN_LAG + SCAN_WOBBLE * 1.5) + 1;
}

/** Radius at which the solid front has reached a point `distance` from the origin. */
export function solidReachesAt(distance: number, reach: number): number {
  return distance + reach * SCAN_LAG;
}

export function createScanUniforms(origin: THREE.Vector3, reach: number): ScanUniforms {
  return {
    uScanOrigin: { value: origin.clone() },
    uScanRadius: { value: 0 },
    uScanEnabled: { value: 1 },
    uScanLag: { value: reach * SCAN_LAG },
    uScanRim: { value: Math.max(reach * SCAN_RIM, 0.6) },
    uScanTrail: { value: reach * SCAN_TRAIL },
    uScanWobble: { value: reach * SCAN_WOBBLE },
    uScanColor: { value: new THREE.Color(SCAN_COLOR) },
    uWireOpacity: { value: 0 },
  };
}

const SCAN_VERTEX_PARS = /* glsl */ `
  varying vec3 vScanWorld;
`;

/**
 * Written after `project_vertex`, where `transformed` is final. Instancing is applied
 * by hand because the stock world-position chunk only exists under some defines, and
 * an instanced tower would otherwise be measured from the centre of its district.
 */
const SCAN_VERTEX = /* glsl */ `
  vec4 scanWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    scanWorld = instanceMatrix * scanWorld;
  #endif
  vScanWorld = (modelMatrix * scanWorld).xyz;
`;

/**
 * The ripple is a pair of slow sines across the world, scaled to the district, so the
 * front breaks over the skyline unevenly instead of as a perfect sphere.
 */
const SCAN_FRAGMENT_PARS = /* glsl */ `
  uniform vec3 uScanOrigin;
  uniform float uScanRadius;
  uniform float uScanEnabled;
  uniform float uScanLag;
  uniform float uScanRim;
  uniform float uScanWobble;
  uniform vec3 uScanColor;
  varying vec3 vScanWorld;

  float fsnScanDistance(vec3 world) {
    float wobble = sin(world.y * 0.9 + world.x * 0.23) * uScanWobble
                 + sin(world.z * 0.31 + world.y * 0.57) * uScanWobble * 0.5;
    return distance(world, uScanOrigin) + wobble;
  }

  bool fsnUnscanned(vec3 world, float lag) {
    if (uScanEnabled < 0.5) return false;
    return fsnScanDistance(world) > uScanRadius - lag;
  }

  float fsnScanRim(vec3 world, float lag) {
    if (uScanEnabled < 0.5) return 0.0;
    float behind = uScanRadius - lag - fsnScanDistance(world);
    return 1.0 - smoothstep(0.0, uScanRim, behind);
  }
`;

/**
 * Teaches a stock material to take part in the scan: anything the solid front has not
 * reached is discarded, and lit materials glow along that front as it passes. Every
 * material given the same uniforms moves together, which is how a whole district
 * (plots, towers, markers, floor, beacon, and their shadows) reveals as one.
 */
export function installScan(material: THREE.Material, uniforms: ScanUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${SCAN_VERTEX_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${SCAN_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SCAN_FRAGMENT_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\n  if (fsnUnscanned(vScanWorld, uScanLag)) discard;",
      )
      // Only lit materials have this chunk; the others simply go without the glow.
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n  totalEmissiveRadiance += uScanColor * fsnScanRim(vScanWorld, uScanLag) * 1.1;",
      );
  };
  // All scan materials compile the same source, so they may share one program; the
  // uniforms are per material, so sharing it is safe.
  material.customProgramCacheKey = () => "fsn-scan";
  material.needsUpdate = true;
}

/**
 * The shadow pass draws with its own depth material, which knows nothing of the scan;
 * without this, the shadows of towers not yet revealed would arrive before them.
 */
export function createScanDepthMaterial(uniforms: ScanUniforms): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  installScan(material, uniforms);
  material.customProgramCacheKey = () => "fsn-scan-depth";
  return material;
}

const WIRE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vScanWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vScanWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WIRE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uScanTrail;
  uniform float uWireOpacity;
  ${SCAN_FRAGMENT_PARS}

  void main() {
    float behind = uScanRadius - fsnScanDistance(vScanWorld);
    if (behind < 0.0) discard;
    // A hot band at the front, then a thin afterglow that dies out across the trail.
    float rim = 1.0 - smoothstep(0.0, uScanRim, behind);
    float trail = 1.0 - smoothstep(uScanRim, uScanTrail, behind);
    float alpha = uWireOpacity * (rim * 0.95 + trail * 0.4);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(mix(uScanColor, vec3(1.0), rim * 0.55), alpha);
  }
`;

export type CageBox = { position: THREE.Vector3; scale: THREE.Vector3 };

/** The twelve edges of a unit cube centred on the origin, as pairs of corner indices. */
const CUBE_EDGES = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
] as const;

/**
 * Every box's edges baked into one world-space line set, so a district of any size is
 * a single draw call. The cage is inflated a hair past the solids so its lines never
 * fight the faces they outline for the same depth.
 */
export function createScanCage(boxes: CageBox[], uniforms: ScanUniforms): THREE.LineSegments {
  const positions = new Float32Array(boxes.length * CUBE_EDGES.length * 2 * 3);
  const corner = new THREE.Vector3();
  let offset = 0;
  for (const box of boxes) {
    const half = box.scale.clone().multiplyScalar(0.5).addScalar(0.015);
    for (const edge of CUBE_EDGES) {
      for (const index of edge) {
        corner.set(
          index & 1 ? half.x : -half.x,
          index & 2 ? half.y : -half.y,
          index & 4 ? half.z : -half.z,
        ).add(box.position);
        positions[offset++] = corner.x;
        positions[offset++] = corner.y;
        positions[offset++] = corner.z;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WIRE_VERTEX_SHADER,
    fragmentShader: WIRE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const cage = new THREE.LineSegments(geometry, material);
  // Drawn after the solids, so the part of the cage a tower hides stays hidden.
  cage.renderOrder = 2;
  return cage;
}
