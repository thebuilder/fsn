import * as THREE from "three";

/**
 * The wires between districts. SGI's navigator drew the hierarchy as pedestals joined
 * by lines, so you could always see where you had come from; here every visited folder
 * is joined, from its plot in the parent district, to the district it opened into. The
 * wire lies low along the floor and carries a pulse outwards, parent to child, which is
 * the direction the tree grows in and the direction you travelled to get there.
 *
 * Endpoints are computed once, from the layout, when a link is made. Nothing here reads
 * a placement's live pose, so a plot lifting under the cursor or rising in a reveal
 * never drags its wire along, and a link is rebuilt only when one of its districts is.
 */

/** A district's floor, as the link sees it: a centre and the half extents of its rim. */
export type LinkFootprint = { x: number; z: number; halfWidth: number; halfDepth: number };

export type LinkEnds = { start: THREE.Vector2; end: THREE.Vector2; length: number };

/**
 * Where a ray from a rectangle's centre leaves it. The rectangle is axis-aligned, so the
 * exit is whichever pair of sides the ray reaches first.
 */
export function rectExit(rect: LinkFootprint, directionX: number, directionZ: number): THREE.Vector2 {
  const length = Math.hypot(directionX, directionZ);
  if (length < 1e-9) return new THREE.Vector2(rect.x, rect.z);
  const unitX = directionX / length;
  const unitZ = directionZ / length;
  const alongX = Math.abs(unitX) > 1e-9 ? rect.halfWidth / Math.abs(unitX) : Infinity;
  const alongZ = Math.abs(unitZ) > 1e-9 ? rect.halfDepth / Math.abs(unitZ) : Infinity;
  const distance = Math.min(alongX, alongZ);
  return new THREE.Vector2(rect.x + unitX * distance, rect.z + unitZ * distance);
}

/**
 * The run of a wire: out of the side of the parent's plot that faces the child, and in
 * at the edge of the child's floor. Aimed centre to centre, so it leaves the plot and
 * meets the district square on rather than skewing across either. Null when the two
 * overlap, which `findAreaCenter`'s margin rules out but a caller should not assume.
 */
export function linkEnds(plot: LinkFootprint, district: LinkFootprint): LinkEnds | null {
  const directionX = district.x - plot.x;
  const directionZ = district.z - plot.z;
  const start = rectExit(plot, directionX, directionZ);
  const end = rectExit(district, -directionX, -directionZ);
  // The wire has to run forwards: if the child's edge is behind the plot's, they overlap.
  const length = (end.x - start.x) * directionX + (end.y - start.y) * directionZ;
  if (length <= 0) return null;
  return { start, end, length: start.distanceTo(end) };
}

/** Height of the ribbon over the floor: enough to clear it without z-fighting. */
const RIBBON_LIFT = 0.035;
const RIBBON_WIDTH = 0.62;
/** The upright fin keeps the wire visible from low angles, where a flat ribbon vanishes. */
const FIN_BELOW = 0.1;
const FIN_ABOVE = 0.26;

/**
 * A conduit is two quads sharing one centre line, one flat and one upright, so from any
 * height it reads as a lit cable rather than a painted stripe. `aAlong` is the distance
 * from the parent end in world units, which the pulse and the growth both run along;
 * `aAcross` goes -1 to 1 over each quad, for a soft edge and a hot core.
 */
export function buildConduit(ends: LinkEnds, floorY: number): THREE.BufferGeometry {
  const { start, end, length } = ends;
  const perpendicularX = -(end.y - start.y) / length;
  const perpendicularZ = (end.x - start.x) / length;
  const half = RIBBON_WIDTH / 2;
  const y = floorY + RIBBON_LIFT;
  const positions: number[] = [];
  const along: number[] = [];
  const across: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    // a/b at the parent end, c/d at the child end; a/c on the -1 side.
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    along.push(0, 0, length, 0, length, length);
    across.push(-1, 1, -1, 1, 1, -1);
  };
  quad(
    new THREE.Vector3(start.x - perpendicularX * half, y, start.y - perpendicularZ * half),
    new THREE.Vector3(start.x + perpendicularX * half, y, start.y + perpendicularZ * half),
    new THREE.Vector3(end.x - perpendicularX * half, y, end.y - perpendicularZ * half),
    new THREE.Vector3(end.x + perpendicularX * half, y, end.y + perpendicularZ * half),
  );
  quad(
    new THREE.Vector3(start.x, y - FIN_BELOW, start.y),
    new THREE.Vector3(start.x, y + FIN_ABOVE, start.y),
    new THREE.Vector3(end.x, y - FIN_BELOW, end.y),
    new THREE.Vector3(end.x, y + FIN_ABOVE, end.y),
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
  geometry.setAttribute("aAcross", new THREE.Float32BufferAttribute(across, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const LINK_VERTEX_SHADER = /* glsl */ `
  attribute float aAlong;
  attribute float aAcross;
  varying float vAlong;
  varying float vAcross;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vAlong = aAlong;
    vAcross = aAcross;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

/**
 * A dim steady glow with a brighter packet riding it outwards. The packet has a sharp
 * head and a long tail, which is what makes the direction legible at a glance: a
 * symmetric blob reads as travelling either way.
 *
 * Tone mapping and colour space are applied by the stock chunks, like any built-in
 * material, so the wire is exposed exactly as the towers are whether the frame is drawn
 * straight to the screen or through the bloom composer. Fog fades it out rather than
 * tinting it: it is added light, and fogging it towards the backdrop would add that.
 */
const LINK_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uPulseColor;
  uniform float uTime;
  uniform float uLength;
  uniform float uGrowth;
  uniform float uOpacity;
  varying float vAlong;
  varying float vAcross;
  #include <common>
  #include <fog_pars_fragment>

  const float PULSE_SPEED = 16.0;
  const float PULSE_TAIL = 7.0;
  const float PULSE_GAP = 26.0;

  void main() {
    float reach = uLength * uGrowth;
    if (vAlong > reach) discard;
    float edge = abs(vAcross);
    float core = exp(-edge * 5.0);
    float body = 1.0 - smoothstep(0.35, 1.0, edge);
    float head = mod(uTime * PULSE_SPEED, uLength + PULSE_GAP);
    float behind = head - vAlong;
    float packet = behind < 0.0 ? exp(behind * 3.0) : pow(max(1.0 - behind / PULSE_TAIL, 0.0), 2.0);
    // The growing tip is the brightest point on the wire while it is being laid.
    float tip = uGrowth < 1.0 ? exp(-(reach - vAlong) * 0.8) : 0.0;
    float lit = (packet + tip) * core;
    vec3 color = uColor * (body * 0.3 + core * 0.5) + uPulseColor * lit * 1.5;
    float alpha = (body * 0.35 + core * 0.35 + lit * 0.8) * uOpacity;
    gl_FragColor = vec4(color, min(alpha, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #ifdef USE_FOG
      gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  }
`;

const LINK_COLOR = 0x3fd9b4;
const PULSE_COLOR = 0xc9fff0;
/** How long a new wire takes to run out from the plot to the district it opened. */
const LINK_GROW = 900;
/** A wire between two districts neither of which is active keeps this much of its glow. */
const LINK_INACTIVE = 0.28;

type LinkUniforms = {
  uColor: THREE.IUniform<THREE.Color>;
  uPulseColor: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  uLength: THREE.IUniform<number>;
  uGrowth: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
};

type Link = {
  parentId: string;
  childId: string;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  uniforms: LinkUniforms;
  grown: number;
};

/**
 * Every link material compiles the same source with the same parameters, so they share a
 * single program; only their uniforms differ. The clock is one uniform object shared by
 * all of them, so the pulses stay in step and advancing time is one write per frame.
 */
function createLinkMaterial(time: THREE.IUniform<number>, length: number): { material: THREE.ShaderMaterial; uniforms: LinkUniforms } {
  const uniforms: LinkUniforms = {
    uColor: { value: new THREE.Color(LINK_COLOR) },
    uPulseColor: { value: new THREE.Color(PULSE_COLOR) },
    uTime: time,
    uLength: { value: length },
    uGrowth: { value: 0 },
    uOpacity: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    vertexShader: LINK_VERTEX_SHADER,
    fragmentShader: LINK_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  return { material, uniforms };
}

export class LinkNetwork {
  /** Added to the scene once; every wire lives here rather than in either district's group. */
  readonly group = new THREE.Group();
  /**
   * Never drawn, only compiled: the warm-up hands it to `compileAsync` with each new
   * district, so the first wire laid does not compile its program in the middle of the
   * flight that is laying it. Its material holds the program for the life of the scene.
   */
  readonly primer: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly time: THREE.IUniform<number> = { value: 0 };
  /** Keyed by the child directory: a folder has one parent, so it has one wire in. */
  private readonly links = new Map<string, Link>();

  constructor() {
    this.group.name = "fsn-links";
    const primerEnds = { start: new THREE.Vector2(0, 0), end: new THREE.Vector2(0.001, 0), length: 0.001 };
    this.primer = new THREE.Mesh(buildConduit(primerEnds, -1000), createLinkMaterial(this.time, 0.001).material);
    this.primer.frustumCulled = false;
  }

  has(childId: string): boolean {
    return this.links.has(childId);
  }

  /**
   * Lays a wire from the plot a folder occupies in its parent to the district it opened
   * into. `grown` starts the wire already laid, for a link made between two districts
   * that were both standing before it (a parent rebuilt after its child).
   */
  connect(parentId: string, childId: string, plot: LinkFootprint, district: LinkFootprint, floorY: number, grown = false): void {
    this.disconnect(childId);
    const ends = linkEnds(plot, district);
    if (!ends) return;
    const { material, uniforms } = createLinkMaterial(this.time, ends.length);
    const mesh = new THREE.Mesh(buildConduit(ends, floorY), material);
    mesh.name = "fsn-link";
    // Drawn after the solids, so a wire running under a tower is hidden by it.
    mesh.renderOrder = 1;
    const link: Link = { parentId, childId, mesh, uniforms, grown: grown ? 1 : 0 };
    uniforms.uGrowth.value = link.grown;
    this.links.set(childId, link);
    this.group.add(mesh);
  }

  /** Drops every wire into or out of a district, for when it is torn down or rebuilt. */
  dropArea(areaId: string): void {
    for (const link of [...this.links.values()]) {
      if (link.parentId === areaId || link.childId === areaId) this.disconnect(link.childId);
    }
  }

  /**
   * Advances the pulse and any wire still being laid, and dims each wire with its
   * districts: it is as bright as the brighter of its two ends, so the way back from where
   * you stand and every way on from it stay lit while the rest of the tree recedes.
   * Growth waits while the reveal is parked, so a wire is not laid to a district that is
   * still hidden behind the welcome screen or its own shader compile.
   */
  update(delta: number, paused: boolean, activationOf: (areaId: string) => number): void {
    this.time.value = (this.time.value + delta) % 3600;
    this.links.forEach((link) => {
      if (!paused && link.grown < 1) {
        link.grown = Math.min(link.grown + (delta * 1000) / LINK_GROW, 1);
        link.uniforms.uGrowth.value = 1 - Math.pow(1 - link.grown, 2);
      }
      const activation = Math.max(activationOf(link.parentId), activationOf(link.childId));
      link.uniforms.uOpacity.value = THREE.MathUtils.lerp(LINK_INACTIVE, 1, activation);
    });
  }

  clear(): void {
    for (const childId of [...this.links.keys()]) this.disconnect(childId);
  }

  dispose(): void {
    this.clear();
    this.primer.geometry.dispose();
    this.primer.material.dispose();
  }

  private disconnect(childId: string): void {
    const link = this.links.get(childId);
    if (!link) return;
    this.links.delete(childId);
    this.group.remove(link.mesh);
    link.mesh.geometry.dispose();
    link.mesh.material.dispose();
  }
}
