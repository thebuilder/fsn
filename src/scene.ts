import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { categoryOf, type FileCategory, type FsNode } from "./filesystem";

type SceneCallbacks = {
  onSelect: (node: FsNode | null) => void;
  onOpen: (node: FsNode) => void;
  onHover: (node: FsNode | null, x: number, y: number) => void;
  onAim: (node: FsNode | null) => void;
  onKeyboardNavigation: (active: boolean) => void;
  /** The camera flew into a directory the user had already visited. */
  onEnterArea: (directoryId: string) => void;
};

type Placement = {
  node: FsNode;
  position: THREE.Vector3;
  scale: THREE.Vector3;
  /** Box the selection and aim outlines wrap. Encloses a plot's markers, not just its slab. */
  outlinePosition: THREE.Vector3;
  outlineScale: THREE.Vector3;
  /** Height at which a label clears this object and whatever stands on it. */
  labelY: number;
  /** Milliseconds into the reveal before this object starts to rise. */
  introDelay: number;
  /** Set once the instanced mesh exists, so hover can address this one instance. */
  mesh?: THREE.InstancedMesh;
  instanceIndex?: number;
  /** Preview markers standing on a directory plot. Never picked; they ride with it. */
  decor: Decor[];
  /** Built on demand the first time this object is close enough on screen to name. */
  label?: THREE.Sprite;
};

/** One preview marker on a directory plot. Decoration only: not selectable, not a node. */
type Decor = {
  category: FileCategory;
  position: THREE.Vector3;
  scale: THREE.Vector3;
  mesh?: THREE.InstancedMesh;
  instanceIndex?: number;
};

export type NavigationDirection = "initial" | "forward" | "backward";

type AreaLayout = {
  placements: Placement[];
  radius: number;
  groundWidth: number;
  groundDepth: number;
  /** Top of the tallest thing standing here, including its label. */
  peakHeight: number;
};

type DirectoryArea = {
  id: string;
  group: THREE.Group;
  center: THREE.Vector3;
  radius: number;
  peakHeight: number;
  placements: Placement[];
  /** Every mesh holding preview markers, so the reveal can flag one update per mesh. */
  decorMeshes: THREE.InstancedMesh[];
  pickMeshes: Map<THREE.InstancedMesh, Placement[]>;
  materials: THREE.Material[];
  labels: THREE.Sprite[];
  /** 1 = fully lit active directory, 0 = dimmed background directory. */
  activation: number;
  activationTarget: number;
};

type AreaIntro = {
  area: DirectoryArea;
  startedAt: number;
};

type CameraFlight = {
  startedAt: number;
  duration: number;
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
};

const palette: Record<FileCategory, number> = {
  directory: 0xf2557e,
  code: 0x5ce1cf,
  // Pre-compensated, not the swatch value. Three of the four lights are cyan-tinted,
  // which starves the red channel: a literal 0xffb84a shades out to rgb(198,164,67),
  // an olive. This renders at hue 37° against the legend's 36°, so images read orange.
  image: 0xff9617,
  audio: 0xb88cff,
  video: 0xff8656,
  document: 0x8bbfff,
  archive: 0xe6de6d,
  model: 0x5ce88a,
  font: 0x4fc6e8,
  system: 0xff5a65,
  unknown: 0x899496,
};

/** The void colour. Background and fog must match exactly or the horizon shows a ring. */
const BACKDROP = 0x05090a;

/** The floor stays neutral so the category palette is the only colour carrying meaning. */
const GROUND_COLOR = 0x14262a;
const RIM_COLOR = 0x0b171a;
const PLOT_COLOR = 0x2c3a44;

/** The district floor: one slab per directory, with everything inside standing on it. */
const GROUND_HEIGHT = 0.5;
const GROUND_Y = -0.12;
const GROUND_TOP = GROUND_Y + GROUND_HEIGHT / 2;
/** Bare floor around the outermost block, proportional so a small district is not a plinth. */
const GROUND_MARGIN_RATIO = 0.16;
const GROUND_MARGIN_MIN = 2.6;
const GROUND_MARGIN_MAX = 6.5;
const RIM_OVERHANG = 1.1;
const RIM_HEIGHT = 0.22;
const GRID_Y = GROUND_Y - GROUND_HEIGHT / 2 - RIM_HEIGHT - 0.04;
const AREA_MARGIN = 22;

/** Towers pack tight within a block; blocks are separated by a street. */
/**
 * A little over one tower wide. Tighter than this and a block of same-coloured towers
 * fuses into a single mass from any angle low enough to see the skyline.
 */
const TOWER_GAP = 1.7;
const PLOT_GAP = 1.7;
const BLOCK_AISLE = 3.8;

/**
 * Each row further from the camera carries its label a lane higher, so a label is never
 * hidden behind the row in front of it. Side-by-side neighbours need no stagger, because
 * `TOWER_GAP` already spaces them further apart than a label is wide.
 *
 * The lane cycles rather than climbing. Only adjacent rows can overlap on screen — rows
 * further apart are already separated by perspective — so a few distinct heights is all
 * it takes. Left to accumulate, a directory deep enough to need ten rows would leave its
 * back labels floating ten units over their towers, attached to nothing.
 */
const LABEL_LANE = 1;
const LABEL_LANE_CYCLE = 3;

/** A directory is a low plot of land carrying one marker per child. */
const PLOT_HEIGHT = 0.62;
const PLOT_TOP = GROUND_TOP + PLOT_HEIGHT;
const PLOT_PADDING = 1.05;
const PLOT_MIN_WIDTH = 4.2;
const MARKER_CELL = 1;
const MARKER_FOOTPRINT = 0.6;
const MARKER_HEIGHT = 1.15;
const MARKER_MAX_COLUMNS = 6;

/** Blocks are laid out in this order, so a directory's shape is stable across visits. */
const CATEGORY_ORDER: FileCategory[] = [
  "directory", "code", "document", "image", "audio", "video", "model", "font", "archive", "system", "unknown",
];

/**
 * Labels are the first thing to clutter a tight layout, so only the nearest few on
 * screen are drawn, re-picked as the camera moves. Sprites are built the first time a
 * label is chosen and cached: 250 of them up front is both a stall and a lot of texture
 * memory, and most of a large directory is never looked at closely.
 */
const LABEL_VISIBLE = 34;
const LABEL_MAX_DISTANCE = 150;
/** Directories are how you travel, so they outrank a file at the same distance. */
const LABEL_DIRECTORY_BONUS = 22;
const LABEL_SELECT_INTERVAL = 120;
/** Cap on canvases rasterised per pick, so flying fast staggers the work over frames. */
const LABEL_BUILDS_PER_TICK = 4;
const LABEL_CACHE_LIMIT = 128;
const EASE_LABEL = 0.000004;

const MOVE_CODES = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyR", "KeyF",
]);
const BASE_SPEED = 20;
const BOOST_MULTIPLIER = 3.5;

/** Reveal: each object rises over INTRO_RISE, staggered outwards across INTRO_STAGGER. */
const INTRO_RISE = 420;
const INTRO_STAGGER = 460;
const INTRO_LABEL_FADE = 240;

/** Per-second decay constants for frame-rate independent easing: 1 - pow(k, delta). */
const EASE_HOVER = 0.000002;
const EASE_AIM = 0.0000005;
const EASE_ACTIVATION = 0.02;
const HOVER_LIFT = 0.35;
/** How long the camera must stay inside an area before it takes over the UI. */
const AREA_DWELL = 400;
const HOVER_TINT = new THREE.Color(1.6, 1.6, 1.6);
const NEUTRAL_TINT = new THREE.Color(1, 1, 1);
const NO_ROTATION = new THREE.Quaternion();

function seededHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

type Footprint = { width: number; depth: number };
type Marker = { category: FileCategory; x: number; z: number };
type Box = Footprint & { node: FsNode; height: number; markers: Marker[] };
/** `lane` counts rows back from the front of the pack, for label stacking. */
type Placed<T> = { item: T; x: number; z: number; lane: number };

/** Comparator that restores the order items arrived in, captured before any sorting. */
function byListing(boxes: Box[]): (a: Box, b: Box) => number {
  const rank = new Map(boxes.map((box, index) => [box.node.id, index]));
  return (a, b) => (rank.get(a.node.id) ?? 0) - (rank.get(b.node.id) ?? 0);
}
type PackResult<T> = { placed: Placed<T>[]; width: number; depth: number };

/**
 * Flows items left to right into rows no wider than `limit`, then centres each row on
 * the origin. A row is only as deep as its own deepest item, so a block of towers stays
 * tight instead of inheriting the largest footprint in the directory.
 *
 * Items arrive sorted tallest first, which fills the rows back to front, and `orderInRow`
 * then restores the caller's reading order across each row. The result steps down towards
 * the camera — nothing tall stands in front of anything short — while each row still
 * reads left to right in listing order.
 */
function shelfPack<T extends Footprint>(
  items: T[],
  gap: number,
  limit: number,
  orderInRow?: (a: T, b: T) => number,
): PackResult<T> {
  const rows: { items: T[]; width: number; depth: number }[] = [];
  for (const item of items) {
    let row = rows[rows.length - 1];
    if (!row || row.width + gap + item.width > limit) {
      row = { items: [], width: 0, depth: 0 };
      rows.push(row);
    }
    if (row.items.length) row.width += gap;
    row.items.push(item);
    row.width += item.width;
    row.depth = Math.max(row.depth, item.depth);
  }

  if (orderInRow) rows.forEach((row) => row.items.sort(orderInRow));

  const width = Math.max(...rows.map((row) => row.width), 0);
  const depth = rows.reduce((total, row) => total + row.depth, 0) + gap * Math.max(rows.length - 1, 0);
  const placed: Placed<T>[] = [];
  let z = -depth / 2;
  rows.forEach((row, index) => {
    let x = -row.width / 2;
    row.items.forEach((item) => {
      placed.push({ item, x: x + item.width / 2, z: z + row.depth / 2, lane: rows.length - 1 - index });
      x += item.width + gap;
    });
    z += row.depth + gap;
  });
  return { placed, width, depth };
}

/** A row width that lands the pack near `aspect`:1 rather than one long corridor. */
function packWidth(items: Footprint[], gap: number, aspect: number): number {
  const area = items.reduce((total, item) => total + (item.width + gap) * (item.depth + gap), 0);
  return Math.max(Math.max(...items.map((item) => item.width), 1), Math.sqrt(area * aspect));
}

/** A file is a tower: footprint roughly constant, height from its size on disk. */
function towerBox(node: FsNode): Box {
  const jitter = seededHash(node.id);
  return {
    node,
    width: 1.45 + (jitter % 4) * 0.1,
    depth: 1.45,
    height: Math.max(0.55, Math.min(7, Math.log2((node.size ?? 1_024) / 1024 + 1) * 0.62)),
    markers: [],
  };
}

/**
 * A directory is a plot of land: its area grows with how much it holds, and it carries
 * one marker per child, coloured by that child's type. The markers are all the same
 * height on purpose — sizes inside a directory are not known without opening every file
 * in it, and a varied skyline would be encoding data that was never read.
 */
function plotBox(node: FsNode): Box {
  const peek = node.peek;
  const total = peek?.total ?? node.children?.length ?? 0;
  const columns = THREE.MathUtils.clamp(Math.round(Math.sqrt(total)), 1, MARKER_MAX_COLUMNS);
  const rows = THREE.MathUtils.clamp(Math.ceil(total / columns), 1, MARKER_MAX_COLUMNS);
  const shown = Math.min(total, columns * rows);

  const markers: Marker[] = [];
  for (let index = 0; index < shown; index += 1) {
    markers.push({
      category: peek?.categories[index] ?? "unknown",
      x: ((index % columns) - (columns - 1) / 2) * MARKER_CELL,
      z: (Math.floor(index / columns) - (rows - 1) / 2) * MARKER_CELL,
    });
  }

  return {
    node,
    width: Math.max(PLOT_MIN_WIDTH, columns * MARKER_CELL + PLOT_PADDING * 2),
    depth: Math.max(PLOT_MIN_WIDTH * 0.8, rows * MARKER_CELL + PLOT_PADDING * 2),
    height: PLOT_HEIGHT,
    markers,
  };
}

function toPlacement(box: Box, x: number, z: number, labelLift: number): Placement {
  const decor = box.markers.map((marker) => ({
    category: marker.category,
    position: new THREE.Vector3(x + marker.x, PLOT_TOP + MARKER_HEIGHT / 2, z + marker.z),
    scale: new THREE.Vector3(MARKER_FOOTPRINT, MARKER_HEIGHT, MARKER_FOOTPRINT),
  }));
  const outlineHeight = box.markers.length ? PLOT_HEIGHT + MARKER_HEIGHT : box.height;
  return {
    node: box.node,
    position: new THREE.Vector3(x, GROUND_TOP + box.height / 2, z),
    scale: new THREE.Vector3(box.width, box.height, box.depth),
    outlinePosition: new THREE.Vector3(x, GROUND_TOP + outlineHeight / 2, z),
    outlineScale: new THREE.Vector3(box.width, outlineHeight, box.depth),
    labelY: labelLift + (box.markers.length ? PLOT_TOP + MARKER_HEIGHT + 0.95 : GROUND_TOP + box.height + 0.82),
    introDelay: 0,
    decor,
  };
}

/**
 * Lays a directory out as a city block plan on one shared floor. Objects of the same
 * category are packed together into a block and the blocks are flowed across the
 * district with streets between them, so the palette reads as neighbourhoods rather
 * than as scattered confetti — and so a plot's size is the only thing on screen that
 * varies with what a directory actually holds.
 */
function buildLayout(nodes: FsNode[]): AreaLayout {
  if (!nodes.length) return { placements: [], radius: 16, groundWidth: 22, groundDepth: 18, peakHeight: 2 };

  const byCategory = new Map<FileCategory, FsNode[]>();
  for (const node of nodes) {
    const category = categoryOf(node);
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(node);
    else byCategory.set(category, [node]);
  }

  const blocks = CATEGORY_ORDER.flatMap((category, categoryRank) => {
    const members = byCategory.get(category);
    if (!members) return [];
    const isDirectory = category === "directory";
    const boxes = members.map((node) => (isDirectory ? plotBox(node) : towerBox(node)));
    const gap = isDirectory ? PLOT_GAP : TOWER_GAP;
    // Tallest to the back, then alphabetical across each row. Plots are all the same
    // low height, so for those the height sort is a no-op and listing order stands.
    const rowOrder = byListing(boxes);
    boxes.sort((a, b) => b.height - a.height);
    const packed = shelfPack(boxes, gap, packWidth(boxes, gap, 1.5), rowOrder);
    return [{
      packed,
      width: packed.width,
      depth: packed.depth,
      categoryRank,
      peak: Math.max(...boxes.map((box) => box.height)),
    }];
  });

  // The same rule one level up: a block of tall towers goes behind the short ones so it
  // cannot wall off the district, while each row still runs in category order.
  const blockOrder = (a: typeof blocks[number], b: typeof blocks[number]) => a.categoryRank - b.categoryRank;
  blocks.sort((a, b) => b.peak - a.peak);
  const district = shelfPack(blocks, BLOCK_AISLE, packWidth(blocks, BLOCK_AISLE, 1.7), blockOrder);
  const placements = district.placed.flatMap(({ item: block, x: blockX, z: blockZ, lane: blockLane }) =>
    block.packed.placed.map(({ item: box, x, z, lane }) =>
      toPlacement(box, blockX + x, blockZ + z, ((blockLane + lane) % LABEL_LANE_CYCLE) * LABEL_LANE)));

  // Ripple the reveal outwards from the centre, capped so a huge directory
  // takes no longer to land than a small one.
  const furthest = Math.max(...placements.map((p) => Math.hypot(p.position.x, p.position.z)), 1);
  placements.forEach((placement) => {
    placement.introDelay = (Math.hypot(placement.position.x, placement.position.z) / furthest) * INTRO_STAGGER;
  });

  const margin = THREE.MathUtils.clamp(
    Math.max(district.width, district.depth) * GROUND_MARGIN_RATIO,
    GROUND_MARGIN_MIN,
    GROUND_MARGIN_MAX,
  );
  const groundWidth = district.width + margin * 2;
  const groundDepth = district.depth + margin * 2;
  return {
    placements,
    radius: Math.hypot(groundWidth, groundDepth) / 2 + 6,
    groundWidth,
    groundDepth,
    peakHeight: Math.max(...placements.map((p) => p.labelY), 0),
  };
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = 512;
  canvas.height = 96;
  if (context) {
    context.font = "600 32px IBM Plex Mono, monospace";
    context.textAlign = "center";
    context.fillStyle = "rgba(3, 8, 9, .72)";
    context.fillRect(0, 10, 512, 62);
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.strokeRect(1, 11, 510, 60);
    context.fillStyle = color;
    const safeText = text.length > 24 ? `${text.slice(0, 22)}…` : text;
    context.fillText(safeText.toUpperCase(), 256, 53);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(5.8, 1.08, 1);
  return sprite;
}

function createGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(106,255,220,.42)");
    gradient.addColorStop(0.32, "rgba(106,255,220,.11)");
    gradient.addColorStop(1, "rgba(106,255,220,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(canvas);
}

const GRID_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

/**
 * Derives the grid from world position rather than from geometry, so the plane can
 * be re-centred on the camera every frame without the lines appearing to slide.
 */
const GRID_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uCamera;
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform float uMinorSpacing;
  uniform float uMajorSpacing;
  uniform float uFadeNear;
  uniform float uFadeFar;
  varying vec3 vWorldPosition;
  layout(location = 0) out vec4 fragColor;

  float gridMask(vec2 point, float spacing) {
    vec2 coord = point / spacing;
    vec2 derivative = max(fwidth(coord), vec2(1e-5));
    vec2 distanceToLine = abs(fract(coord - 0.5) - 0.5) / derivative;
    return 1.0 - min(min(distanceToLine.x, distanceToLine.y), 1.0);
  }

  void main() {
    float minor = gridMask(vWorldPosition.xz, uMinorSpacing);
    float major = gridMask(vWorldPosition.xz, uMajorSpacing);
    float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, distance(vWorldPosition.xz, uCamera.xz));
    float alpha = max(minor * 0.32, major * 0.7) * fade;
    if (alpha < 0.002) discard;
    fragColor = vec4(mix(uMinorColor, uMajorColor, major), alpha);
  }
`;

export class WorldScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly worldGroup = new THREE.Group();
  private readonly areas = new Map<string, DirectoryArea>();
  private readonly pickMeshes = new Map<THREE.InstancedMesh, Placement[]>();
  private readonly selectionBox: THREE.LineSegments;
  private readonly aimBox: THREE.LineSegments;
  private readonly clock = new THREE.Clock();
  private readonly keyLight: THREE.DirectionalLight;
  private readonly gridMaterial: THREE.ShaderMaterial;
  private readonly grid: THREE.Mesh;
  private readonly sky: THREE.Group;
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GRID_Y);
  private readonly movement = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private currentArea: DirectoryArea | null = null;
  private flight: CameraFlight | null = null;
  private intro: AreaIntro | null = null;
  private hovered: FsNode | null = null;
  private aimed: Placement | null = null;
  private keyboardNavigationActive = false;
  private boosting = false;
  private lastAimCheck = 0;
  private frame = 0;
  private pendingArea: DirectoryArea | null = null;
  private pendingSince = 0;
  private hoverTarget: Placement | null = null;
  private hoverShown: Placement | null = null;
  private hoverStrength = 0;
  private aimBoxOpacity = 0;
  private readonly scratchColor = new THREE.Color();
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchVector = new THREE.Vector3();
  private readonly labelFrustum = new THREE.Frustum();
  private readonly labelViewProjection = new THREE.Matrix4();
  /** Given a little volume so labels fade in before their anchor crosses the screen edge. */
  private readonly labelSphere = new THREE.Sphere(new THREE.Vector3(), 2.5);
  private readonly labelPoint = new THREE.Vector3();
  private labelCandidates: { placement: Placement; area: DirectoryArea; score: number }[] = [];
  private lastLabelSelect = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: SceneCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(BACKDROP);
    this.scene.fog = new THREE.Fog(BACKDROP, 110, 520);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 3000);
    this.camera.position.set(0, 16, 30);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.target.set(0, 1.2, 6);
    this.controls.minDistance = 3;
    this.controls.maxDistance = 600;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

    // Neutral key so the category palette survives; colour lives in the rim instead.
    this.scene.add(new THREE.HemisphereLight(0xa8e8ff, 0x101c1e, 0.85));
    this.keyLight = new THREE.DirectionalLight(0xffeef0, 1.75);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.05;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    const rim = new THREE.DirectionalLight(0x6fffe0, 0.85);
    rim.position.set(14, 8, 12);
    this.scene.add(rim);

    // Parented to the camera so nothing is ever unlit, however far out you fly.
    const headlight = new THREE.DirectionalLight(0xcdeee5, 0.55);
    headlight.target.position.set(0, 0, -1);
    this.camera.add(headlight);
    this.camera.add(headlight.target);

    const environment = this.createEnvironment();
    this.grid = environment.grid;
    this.gridMaterial = environment.gridMaterial;
    this.sky = environment.sky;
    this.scene.add(this.worldGroup);

    const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.selectionBox = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color: 0xf4ffd9, transparent: true, opacity: 0.95 }));
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);
    this.aimBox = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color: 0x7fffe0, transparent: true, opacity: 0.5 }));
    this.aimBox.visible = false;
    this.scene.add(this.aimBox);

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    // Capture phase: a key release must reach us even if something nearer the target
    // stops the event, or the camera would keep drifting with nothing to cancel it.
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.releaseMovement);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    new ResizeObserver(this.resize).observe(canvas);
    this.animate();
  }

  setDirectory(directory: FsNode, nodes: FsNode[], direction: NavigationDirection): void {
    if (direction === "initial") this.disposeWorld();

    let area = this.areas.get(directory.id);
    let isNew = false;
    if (!area) {
      const layout = buildLayout(nodes);
      const center = direction === "initial" ? new THREE.Vector3() : this.findAreaCenter(directory, layout.radius);
      area = this.createArea(directory.id, center, layout);
      this.areas.set(directory.id, area);
      this.worldGroup.add(area.group);
      isNew = true;
    }

    this.setActiveArea(area);
    // Only reveal on first build; re-entering a known directory should not replay it.
    if (isNew) this.startIntro(area);
    this.flyToArea(area, direction === "initial");
    this.clearSelectionAndAim();
  }

  private createArea(id: string, center: THREE.Vector3, layout: AreaLayout): DirectoryArea {
    const group = new THREE.Group();
    group.userData.directoryArea = id;
    const placements = layout.placements;
    placements.forEach((placement) => {
      placement.position.add(center);
      placement.outlinePosition.add(center);
      placement.decor.forEach((decor) => decor.position.add(center));
    });

    const materials: THREE.Material[] = [];
    const matrix = new THREE.Matrix4();

    // The floor of the district, plus a wider lip underneath so it reads as a solid
    // block of land sitting in the void rather than a sheet of paper.
    const rimMaterial = new THREE.MeshLambertMaterial({ color: RIM_COLOR, emissive: RIM_COLOR, emissiveIntensity: 0.1 });
    rememberActiveLook(rimMaterial);
    materials.push(rimMaterial);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), rimMaterial);
    rim.scale.set(layout.groundWidth + RIM_OVERHANG * 2, RIM_HEIGHT, layout.groundDepth + RIM_OVERHANG * 2);
    rim.position.set(center.x, GROUND_Y - GROUND_HEIGHT / 2 - RIM_HEIGHT / 2, center.z);
    group.add(rim);

    const groundMaterial = new THREE.MeshLambertMaterial({ color: GROUND_COLOR, emissive: GROUND_COLOR, emissiveIntensity: 0.16 });
    rememberActiveLook(groundMaterial);
    materials.push(groundMaterial);
    const ground = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), groundMaterial);
    ground.scale.set(layout.groundWidth, GROUND_HEIGHT, layout.groundDepth);
    ground.position.set(center.x, GROUND_Y, center.z);
    ground.receiveShadow = true;
    group.add(ground);

    const grouped = new Map<FileCategory, Placement[]>();
    placements.forEach((placement) => {
      const category = categoryOf(placement.node);
      grouped.set(category, [...(grouped.get(category) ?? []), placement]);
    });

    const pickMeshes = new Map<THREE.InstancedMesh, Placement[]>();
    for (const [category, categoryPlacements] of grouped) {
      // A directory's body is the plot itself, kept neutral: the markers standing on it
      // are what carry colour, and a crimson slab under them would drown them out.
      const isDirectory = category === "directory";
      const bodyColor = isDirectory ? PLOT_COLOR : palette[category];
      const buildingMaterial = new THREE.MeshLambertMaterial({
        color: bodyColor,
        emissive: bodyColor,
        emissiveIntensity: isDirectory ? 0.2 : 0.05,
      });
      rememberActiveLook(buildingMaterial);
      materials.push(buildingMaterial);
      const buildingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMaterial, categoryPlacements.length);
      buildingMesh.castShadow = true;
      buildingMesh.receiveShadow = true;
      categoryPlacements.forEach((placement, index) => {
        matrix.compose(placement.position, NO_ROTATION, placement.scale);
        buildingMesh.setMatrixAt(index, matrix);
      });
      buildingMesh.instanceMatrix.needsUpdate = true;
      // Establish instanceColor up front so the first hover does not recompile the shader.
      categoryPlacements.forEach((placement, index) => {
        buildingMesh.setColorAt(index, NEUTRAL_TINT);
        placement.mesh = buildingMesh;
        placement.instanceIndex = index;
      });
      if (buildingMesh.instanceColor) buildingMesh.instanceColor.needsUpdate = true;
      buildingMesh.computeBoundingBox();
      buildingMesh.computeBoundingSphere();
      pickMeshes.set(buildingMesh, categoryPlacements);
      group.add(buildingMesh);
    }

    // Preview markers, batched by their own category across every plot in the area.
    // Deliberately outside `pickMeshes`: the ray ignores them, so clicking a marker
    // falls through to the plot beneath it and selects the directory, as it should.
    const decorMeshes: THREE.InstancedMesh[] = [];
    const markersByCategory = new Map<FileCategory, Decor[]>();
    placements.forEach((placement) => placement.decor.forEach((decor) => {
      const bucket = markersByCategory.get(decor.category);
      if (bucket) bucket.push(decor);
      else markersByCategory.set(decor.category, [decor]);
    }));
    for (const [category, markers] of markersByCategory) {
      const markerMaterial = new THREE.MeshLambertMaterial({
        color: palette[category],
        emissive: palette[category],
        emissiveIntensity: 0.14,
      });
      rememberActiveLook(markerMaterial);
      materials.push(markerMaterial);
      const markerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), markerMaterial, markers.length);
      markerMesh.castShadow = true;
      markers.forEach((decor, index) => {
        matrix.compose(decor.position, NO_ROTATION, decor.scale);
        markerMesh.setMatrixAt(index, matrix);
        decor.mesh = markerMesh;
        decor.instanceIndex = index;
      });
      markerMesh.instanceMatrix.needsUpdate = true;
      markerMesh.computeBoundingBox();
      markerMesh.computeBoundingSphere();
      decorMeshes.push(markerMesh);
      group.add(markerMesh);
    }

    // Labels are not built here. `selectLabels` names whatever is nearest on screen and
    // creates the sprite at that moment, so this list fills in as the camera explores.
    const labels: THREE.Sprite[] = [];

    const beaconSize = Math.max(48, layout.radius * 2.4);
    const beacon = new THREE.Mesh(new THREE.PlaneGeometry(beaconSize, beaconSize), new THREE.MeshBasicMaterial({
      map: createGlowTexture(),
      color: 0x68ffda,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    beacon.position.set(center.x, GRID_Y + 0.02, center.z);
    beacon.rotation.x = -Math.PI / 2;
    beacon.material.userData.activeOpacity = 0.16;
    materials.push(beacon.material);
    group.add(beacon);

    // Born lit: a new area is revealed by the growth animation, not by a fade-up.
    return {
      id, group, center: center.clone(), radius: layout.radius, peakHeight: layout.peakHeight,
      placements, decorMeshes, pickMeshes, materials, labels,
      activation: 1, activationTarget: 1,
    };
  }

  /**
   * Places a new directory beyond the parent's footprint, spiralling outwards from
   * the direction of the folder that was opened until the slot clears every area
   * already in the world.
   */
  private findAreaCenter(directory: FsNode, radius: number): THREE.Vector3 {
    const source = this.currentArea;
    if (!source) return new THREE.Vector3();

    const entrance = source.placements.find((placement) => placement.node.id === directory.id);
    const heading = entrance
      ? new THREE.Vector3().subVectors(entrance.position, source.center).setY(0)
      : new THREE.Vector3();
    if (heading.lengthSq() < 1) {
      const angle = (seededHash(directory.id) % 360) * (Math.PI / 180);
      heading.set(Math.cos(angle), 0, Math.sin(angle));
    }
    const baseAngle = Math.atan2(heading.z, heading.x);

    const candidate = new THREE.Vector3();
    for (let ring = 0; ring < 24; ring += 1) {
      const distance = source.radius + radius + AREA_MARGIN + ring * 16;
      for (let step = 0; step < 16; step += 1) {
        const swing = Math.ceil(step / 2) * (Math.PI / 8) * (step % 2 === 0 ? 1 : -1);
        const angle = baseAngle + swing;
        candidate.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(distance).add(source.center);
        if (this.isCenterFree(candidate, radius)) return candidate.clone();
      }
    }
    return candidate.clone();
  }

  private isCenterFree(center: THREE.Vector3, radius: number): boolean {
    for (const area of this.areas.values()) {
      if (center.distanceTo(area.center) < radius + area.radius + AREA_MARGIN) return false;
    }
    return true;
  }

  private setActiveArea(area: DirectoryArea): void {
    this.currentArea = area;
    this.pickMeshes.clear();
    area.pickMeshes.forEach((placements, mesh) => this.pickMeshes.set(mesh, placements));
    this.areas.forEach((candidate) => {
      candidate.activationTarget = candidate.id === area.id ? 1 : 0;
    });
    this.focusLightOn(area);
  }

  /**
   * Re-picks which objects are named, then eases every label towards being shown or
   * hidden. The pick is throttled because it is a scan over every placement in the
   * world; the fade runs every frame so labels never pop.
   */
  private updateLabels(delta: number): void {
    const now = performance.now();
    if (now - this.lastLabelSelect > LABEL_SELECT_INTERVAL) {
      this.lastLabelSelect = now;
      this.selectLabels(now);
    }
    const step = 1 - Math.pow(EASE_LABEL, delta);
    this.areas.forEach((area) => {
      area.labels.forEach((sprite) => {
        const data = sprite.material.userData;
        data.proximityFade += (data.proximityTarget - data.proximityFade) * step;
        writeLabelOpacity(sprite, area.activation);
      });
    });
  }

  /** Chooses the nearest labels that are actually on screen, nearest first. */
  private selectLabels(now: number): void {
    this.labelViewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.labelFrustum.setFromProjectionMatrix(this.labelViewProjection);

    const candidates = this.labelCandidates;
    candidates.length = 0;
    this.areas.forEach((area) => {
      if (this.camera.position.distanceTo(area.center) > area.radius + LABEL_MAX_DISTANCE) return;
      for (const placement of area.placements) {
        this.labelPoint.set(placement.position.x, placement.labelY, placement.position.z);
        const distance = this.camera.position.distanceTo(this.labelPoint);
        if (distance > LABEL_MAX_DISTANCE) continue;
        this.labelSphere.center.copy(this.labelPoint);
        if (!this.labelFrustum.intersectsSphere(this.labelSphere)) continue;
        const bonus = placement.node.kind === "directory" ? LABEL_DIRECTORY_BONUS : 0;
        candidates.push({ placement, area, score: distance - bonus });
      }
    });
    candidates.sort((a, b) => a.score - b.score);

    const shown = new Set<Placement>();
    let built = 0;
    for (const candidate of candidates) {
      if (shown.size >= LABEL_VISIBLE) break;
      let sprite = candidate.placement.label;
      if (!sprite) {
        // Out of build budget: leave it for the next pick rather than stalling the frame.
        if (built >= LABEL_BUILDS_PER_TICK) continue;
        sprite = this.buildLabel(candidate.placement, candidate.area);
        built += 1;
      }
      sprite.userData.lastSeen = now;
      sprite.material.userData.proximityTarget = 1;
      shown.add(candidate.placement);
    }

    this.areas.forEach((area) => area.labels.forEach((sprite) => {
      if (!shown.has(sprite.userData.placement as Placement)) sprite.material.userData.proximityTarget = 0;
    }));

    this.trimLabelCache();
  }

  private buildLabel(placement: Placement, area: DirectoryArea): THREE.Sprite {
    const isDirectory = placement.node.kind === "directory";
    const color = palette[categoryOf(placement.node)];
    const sprite = makeLabel(placement.node.name, `#${color.toString(16).padStart(6, "0")}`);
    sprite.position.set(placement.position.x, placement.labelY, placement.position.z);
    sprite.scale.set(isDirectory ? 5.2 : 3.1, isDirectory ? 0.97 : 0.58, 1);
    sprite.userData.placement = placement;
    sprite.userData.introDelay = placement.introDelay;
    sprite.material.userData.proximityFade = 0;
    sprite.material.userData.proximityTarget = 1;
    // A label born mid-reveal joins the ripple; one born later has no catching up to do.
    sprite.material.userData.introFade = this.intro?.area === area ? 0 : 1;
    sprite.visible = false;
    placement.label = sprite;
    area.labels.push(sprite);
    area.group.add(sprite);
    return sprite;
  }

  /** Drops the least recently shown labels once the cache outgrows its budget. */
  private trimLabelCache(): void {
    let total = 0;
    this.areas.forEach((area) => (total += area.labels.length));
    if (total <= LABEL_CACHE_LIMIT) return;

    const stale: { sprite: THREE.Sprite; area: DirectoryArea }[] = [];
    this.areas.forEach((area) => area.labels.forEach((sprite) => {
      const data = sprite.material.userData;
      if (data.proximityTarget === 0 && data.proximityFade < 0.02) stale.push({ sprite, area });
    }));
    stale.sort((a, b) => (a.sprite.userData.lastSeen as number) - (b.sprite.userData.lastSeen as number));

    for (const entry of stale) {
      if (total <= LABEL_CACHE_LIMIT) break;
      const placement = entry.sprite.userData.placement as Placement;
      placement.label = undefined;
      entry.area.labels.splice(entry.area.labels.indexOf(entry.sprite), 1);
      entry.area.group.remove(entry.sprite);
      entry.sprite.material.map?.dispose();
      entry.sprite.material.dispose();
      total -= 1;
    }
  }

  /** Eases every area towards its activation target so directories cross-fade. */
  private updateActivation(delta: number): void {
    const step = 1 - Math.pow(EASE_ACTIVATION, delta);
    this.areas.forEach((area) => {
      const difference = area.activationTarget - area.activation;
      if (Math.abs(difference) < 0.002) {
        if (area.activation === area.activationTarget) return;
        area.activation = area.activationTarget;
      } else {
        area.activation += difference * step;
      }
      area.materials.forEach((material) => applyAreaLook(material, area.activation));
    });
  }

  private clearSelectionAndAim(): void {
    this.selectionBox.visible = false;
    this.aimed = null;
    this.aimBox.visible = false;
    this.callbacks.onAim(null);
    this.callbacks.onSelect(null);
  }

  /**
   * Flying back into a directory you already visited makes it active again, so its
   * objects become selectable without having to navigate there through the UI.
   * The dwell means merely passing over an area on the way somewhere else does not
   * keep re-targeting the breadcrumb.
   *
   * This tests the orbit target, not the camera: framing an area parks the camera a
   * radius and a half back from it, so the camera is never inside its own area. The
   * target is what the view is centred on, which is the question actually being
   * asked. It also means orbiting and zooming never change directories, while
   * flying and panning do.
   */
  private checkAreaEntry(): void {
    if (this.flight || !this.currentArea) {
      this.pendingArea = null;
      return;
    }
    let entered: DirectoryArea | null = null;
    let closest = Infinity;
    for (const area of this.areas.values()) {
      const distance = Math.hypot(this.controls.target.x - area.center.x, this.controls.target.z - area.center.z);
      if (distance < area.radius && distance < closest) {
        entered = area;
        closest = distance;
      }
    }
    if (!entered || entered === this.currentArea) {
      this.pendingArea = null;
      return;
    }
    if (this.pendingArea !== entered) {
      this.pendingArea = entered;
      this.pendingSince = performance.now();
      return;
    }
    if (performance.now() - this.pendingSince < AREA_DWELL) return;
    this.pendingArea = null;
    this.setActiveArea(entered);
    this.clearSelectionAndAim();
    this.callbacks.onEnterArea(entered.id);
  }

  /** Refits the shadow camera to the active directory so the map is never wasted. */
  private focusLightOn(area: DirectoryArea): void {
    const radius = area.radius;
    this.keyLight.target.position.copy(area.center);
    this.keyLight.target.updateMatrixWorld();
    this.keyLight.position.copy(area.center).add(new THREE.Vector3(-radius * 0.7, radius * 1.15 + 30, -radius * 0.5));
    const shadowCamera = this.keyLight.shadow.camera;
    shadowCamera.left = -radius * 1.2;
    shadowCamera.right = radius * 1.2;
    shadowCamera.top = radius * 1.2;
    shadowCamera.bottom = -radius * 1.2;
    shadowCamera.near = 1;
    shadowCamera.far = radius * 3 + 120;
    shadowCamera.updateProjectionMatrix();
  }

  /**
   * Frames the whole district from a raised three-quarter angle. Packing the objects
   * tightly shrank the footprint without shrinking the towers, so the distance has to
   * clear the skyline as well as the floor or the view ends up looking along the
   * streets at eye level instead of over the city.
   */
  private flyToArea(area: DirectoryArea, immediate: boolean): void {
    const distance = Math.max(22, area.radius * 1.7, area.peakHeight * 3.6);
    const toTarget = area.center.clone().add(new THREE.Vector3(0, area.peakHeight * 0.3, 0));
    const toPosition = area.center.clone().add(new THREE.Vector3(0, distance * 0.68, distance));
    this.flyTo(toTarget, toPosition, immediate);
  }

  private flyTo(toTarget: THREE.Vector3, toPosition: THREE.Vector3, immediate = false): void {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (immediate || reducedMotion) {
      this.flight = null;
      this.camera.position.copy(toPosition);
      this.controls.target.copy(toTarget);
      this.controls.enabled = true;
      this.controls.update();
      return;
    }
    this.velocity.set(0, 0, 0);
    const distance = this.camera.position.distanceTo(toPosition);
    this.flight = {
      startedAt: performance.now(),
      duration: THREE.MathUtils.clamp(distance * 12, 350, 1400),
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition,
      toTarget,
    };
    this.controls.enabled = false;
  }

  private cancelFlight(): void {
    if (!this.flight) return;
    this.flight = null;
    this.controls.enabled = true;
  }

  private startIntro(area: DirectoryArea): void {
    if (this.intro) this.finishIntro();
    if (!area.placements.length) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.intro = { area, startedAt: performance.now() };
    area.labels.forEach((label) => (label.material.userData.introFade = 0));
    this.applyIntro(0);
  }

  /** Writes the reveal pose for `elapsed` ms; returns true once every object has landed. */
  private applyIntro(elapsed: number): boolean {
    const intro = this.intro;
    if (!intro) return true;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    let settled = true;

    intro.area.placements.forEach((placement) => {
      const progress = THREE.MathUtils.clamp((elapsed - placement.introDelay) / INTRO_RISE, 0, 1);
      if (progress < 1) settled = false;
      const eased = 1 - Math.pow(1 - progress, 3);
      const height = Math.max(placement.scale.y * eased, 0.0001);
      if (placement.mesh && placement.instanceIndex !== undefined) {
        position.set(placement.position.x, GROUND_TOP + height / 2, placement.position.z);
        scale.set(placement.scale.x, height, placement.scale.z);
        matrix.compose(position, rotation, scale);
        placement.mesh.setMatrixAt(placement.instanceIndex, matrix);
      }
      // Markers grow on the plot's rising surface, so a plot never sprouts through them.
      placement.decor.forEach((decor) => {
        if (!decor.mesh || decor.instanceIndex === undefined) return;
        const markerHeight = Math.max(decor.scale.y * eased, 0.0001);
        position.set(decor.position.x, GROUND_TOP + height + markerHeight / 2, decor.position.z);
        scale.set(decor.scale.x, markerHeight, decor.scale.z);
        matrix.compose(position, rotation, scale);
        decor.mesh.setMatrixAt(decor.instanceIndex, matrix);
      });
    });
    intro.area.pickMeshes.forEach((_placements, mesh) => (mesh.instanceMatrix.needsUpdate = true));
    intro.area.decorMeshes.forEach((mesh) => (mesh.instanceMatrix.needsUpdate = true));

    // Opacity itself belongs to `updateLabels`; the reveal only drives its own factor.
    intro.area.labels.forEach((label) => {
      const delay = (label.userData.introDelay as number) + INTRO_RISE * 0.6;
      const progress = THREE.MathUtils.clamp((elapsed - delay) / INTRO_LABEL_FADE, 0, 1);
      if (progress < 1) settled = false;
      label.material.userData.introFade = progress;
    });

    return settled;
  }

  /** Snaps every object to its final pose and ends the reveal. */
  private finishIntro(): void {
    const intro = this.intro;
    if (!intro) return;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    intro.area.placements.forEach((placement) => {
      if (placement.mesh && placement.instanceIndex !== undefined) {
        matrix.compose(placement.position, rotation, placement.scale);
        placement.mesh.setMatrixAt(placement.instanceIndex, matrix);
      }
      placement.decor.forEach((decor) => {
        if (!decor.mesh || decor.instanceIndex === undefined) return;
        matrix.compose(decor.position, rotation, decor.scale);
        decor.mesh.setMatrixAt(decor.instanceIndex, matrix);
      });
    });
    intro.area.pickMeshes.forEach((_placements, mesh) => (mesh.instanceMatrix.needsUpdate = true));
    intro.area.decorMeshes.forEach((mesh) => (mesh.instanceMatrix.needsUpdate = true));
    intro.area.labels.forEach((label) => (label.material.userData.introFade = 1));
    this.intro = null;
  }

  focusNode(node: FsNode): void {
    const placement = [...this.pickMeshes.values()].flat().find((candidate) => candidate.node.id === node.id);
    if (!placement) return;
    this.selectPlacement(placement);
    const target = placement.position.clone().setY(Math.max(1, placement.position.y));
    const direction = new THREE.Vector3().subVectors(this.camera.position, target).normalize();
    this.flyTo(target, target.clone().add(direction.multiplyScalar(11)));
  }

  /** Returns the camera to the active directory after wandering off. */
  refocus(): void {
    if (this.currentArea) this.flyToArea(this.currentArea, false);
  }

  getAimedNode(): FsNode | null {
    return this.aimed?.node ?? null;
  }

  setKeyboardNavigationActive(active: boolean): void {
    if (this.keyboardNavigationActive !== active) {
      this.keyboardNavigationActive = active;
      this.callbacks.onKeyboardNavigation(active);
    }
    this.aimBox.visible = active && Boolean(this.aimed);
  }

  selectAimed(): FsNode | null {
    if (!this.aimed) return null;
    this.selectPlacement(this.aimed);
    return this.aimed.node;
  }

  private createEnvironment(): { grid: THREE.Mesh; gridMaterial: THREE.ShaderMaterial; sky: THREE.Group } {
    const gridMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uCamera: { value: new THREE.Vector3() },
        uMinorColor: { value: new THREE.Color(0x1e6459) },
        uMajorColor: { value: new THREE.Color(0x46b09c) },
        uMinorSpacing: { value: 2.7 },
        uMajorSpacing: { value: 27 },
        uFadeNear: { value: 70 },
        uFadeFar: { value: 470 },
      },
      vertexShader: GRID_VERTEX_SHADER,
      fragmentShader: GRID_FRAGMENT_SHADER,
    });
    const gridGeometry = new THREE.PlaneGeometry(1, 1);
    gridGeometry.rotateX(-Math.PI / 2);
    const grid = new THREE.Mesh(gridGeometry, gridMaterial);
    grid.scale.setScalar(1100);
    grid.position.y = GRID_Y;
    grid.frustumCulled = false;
    grid.renderOrder = -1;
    this.scene.add(grid);

    // A star dome that rides with the camera, so the sky never runs out either.
    const sky = new THREE.Group();
    const starCount = 700;
    const positions = new Float32Array(starCount * 3);
    for (let index = 0; index < starCount; index += 1) {
      const radius = 620 + Math.random() * 280;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.92);
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = radius * Math.cos(phi);
      positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({
      color: 0x83c9b8,
      size: 1.9,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
    }));
    stars.frustumCulled = false;
    sky.add(stars);
    sky.renderOrder = -2;
    this.scene.add(sky);

    return { grid, gridMaterial, sky };
  }

  private disposeWorld(): void {
    this.pickMeshes.clear();
    this.areas.clear();
    this.currentArea = null;
    this.flight = null;
    this.intro = null;
    this.hoverTarget = null;
    this.hoverShown = null;
    this.hoverStrength = 0;
    while (this.worldGroup.children.length) {
      const object = this.worldGroup.children.pop();
      if (!object) continue;
      object.traverse((descendant) => {
        if (!(descendant instanceof THREE.Mesh || descendant instanceof THREE.Line || descendant instanceof THREE.Sprite)) return;
        descendant.geometry?.dispose();
        const materials = Array.isArray(descendant.material) ? descendant.material : [descendant.material];
        materials.forEach((material) => {
          if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
          material.dispose();
        });
      });
    }
  }

  private hitTest(clientX: number, clientY: number): Placement | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return this.hitAtNdc(x, y);
  }

  private hitAtNdc(x: number, y: number): Placement | null {
    this.pointer.set(x, y);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.pickMeshes.keys()], false);
    const hit = hits[0];
    if (!hit || hit.instanceId === undefined || !(hit.object instanceof THREE.InstancedMesh)) return null;
    return this.pickMeshes.get(hit.object)?.[hit.instanceId] ?? null;
  }

  private updateAim(): void {
    const nextAim = this.flight ? null : this.hitAtNdc(0, 0);
    if (nextAim?.node.id === this.aimed?.node.id) return;
    const acquiredFromNothing = !this.aimed;
    this.aimed = nextAim;
    // Sliding from a stale position would read as a glitch, so snap on first acquire.
    if (nextAim && acquiredFromNothing) {
      this.aimBox.position.copy(nextAim.outlinePosition);
      this.aimBox.scale.copy(nextAim.outlineScale).multiplyScalar(1.14);
    }
    this.callbacks.onAim(nextAim?.node ?? null);
  }

  /** Glides the aim outline between targets instead of teleporting it. */
  private updateAimBox(delta: number): void {
    const step = 1 - Math.pow(EASE_AIM, delta);
    if (this.aimed) {
      this.aimBox.position.lerp(this.aimed.outlinePosition, step);
      this.aimBox.scale.lerp(this.scratchVector.copy(this.aimed.outlineScale).multiplyScalar(1.14), step);
    }
    const target = this.keyboardNavigationActive && this.aimed ? 0.5 : 0;
    this.aimBoxOpacity += (target - this.aimBoxOpacity) * step;
    (this.aimBox.material as THREE.LineBasicMaterial).opacity = this.aimBoxOpacity;
    this.aimBox.visible = this.aimBoxOpacity > 0.01;
  }

  /** Lifts and brightens the object under the cursor, cross-fading through zero. */
  private updateHoverHighlight(delta: number): void {
    const step = 1 - Math.pow(EASE_HOVER, delta);
    if (this.hoverShown !== this.hoverTarget) {
      if (this.hoverShown && this.hoverStrength > 0.01) {
        this.hoverStrength += (0 - this.hoverStrength) * step;
        this.writeHover(this.hoverShown, this.hoverStrength);
        return;
      }
      if (this.hoverShown) this.writeHover(this.hoverShown, 0);
      this.hoverShown = this.hoverTarget;
      this.hoverStrength = 0;
    }
    if (!this.hoverShown) return;
    const settled = Math.abs(1 - this.hoverStrength) < 0.005;
    if (settled) return;
    this.hoverStrength += (1 - this.hoverStrength) * step;
    this.writeHover(this.hoverShown, this.hoverStrength);
  }

  private writeHover(placement: Placement, strength: number): void {
    const mesh = placement.mesh;
    if (!mesh || placement.instanceIndex === undefined) return;
    const lift = HOVER_LIFT * strength;
    mesh.setColorAt(placement.instanceIndex, this.scratchColor.copy(NEUTRAL_TINT).lerp(HOVER_TINT, strength));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scratchVector.copy(placement.position).setY(placement.position.y + lift);
    this.scratchMatrix.compose(this.scratchVector, NO_ROTATION, placement.scale);
    mesh.setMatrixAt(placement.instanceIndex, this.scratchMatrix);
    mesh.instanceMatrix.needsUpdate = true;

    // A plot lifting out from under its own markers would tear the preview apart.
    placement.decor.forEach((decor) => {
      if (!decor.mesh || decor.instanceIndex === undefined) return;
      this.scratchVector.copy(decor.position).setY(decor.position.y + lift);
      this.scratchMatrix.compose(this.scratchVector, NO_ROTATION, decor.scale);
      decor.mesh.setMatrixAt(decor.instanceIndex, this.scratchMatrix);
      decor.mesh.instanceMatrix.needsUpdate = true;
    });
  }

  private selectPlacement(placement: Placement): void {
    this.selectionBox.visible = true;
    this.selectionBox.position.copy(placement.outlinePosition);
    this.selectionBox.scale.copy(placement.outlineScale).multiplyScalar(1.06);
    this.callbacks.onSelect(placement.node);
  }

  private onPointerMove = (event: PointerEvent): void => {
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit?.node.id !== this.hovered?.id) {
      this.hovered = hit?.node ?? null;
      this.canvas.style.cursor = hit ? "crosshair" : "grab";
    }
    this.hoverTarget = hit;
    this.callbacks.onHover(hit?.node ?? null, event.clientX, event.clientY);
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.setKeyboardNavigationActive(false);
    this.canvas.focus({ preventScroll: true });
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit) this.selectPlacement(hit);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit) {
      this.callbacks.onOpen(hit.node);
      return;
    }
    // Empty ground: travel there, keeping the current viewing angle and distance.
    const destination = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, destination)) return;
    if (destination.distanceTo(this.controls.target) > 900) return;
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    destination.y = 1.2;
    this.flyTo(destination, destination.clone().add(offset));
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    this.boosting = event.shiftKey;
    // While a command key is down macOS withholds keyup for everything else, so a
    // movement key let go during a shortcut would never be removed and the camera
    // would fly on forever. Treat the modifier going down as releasing the lot.
    if (event.metaKey || event.ctrlKey) {
      this.releaseMovement();
      return;
    }
    // Typing or a dialog takes the keyboard away mid-flight; stop rather than coast.
    if (isTypingTarget(event.target) || document.querySelector("dialog[open]")) {
      this.releaseMovement();
      return;
    }
    if (!MOVE_CODES.has(event.code)) return;
    event.preventDefault();
    this.setKeyboardNavigationActive(true);
    this.movement.add(event.code);
    this.cancelFlight();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.boosting = event.shiftKey;
    // Anything released during a Cmd/Ctrl chord reported no keyup of its own, so the
    // modifier's release is the first moment the set can be trusted again.
    if (event.key === "Meta" || event.key === "Control") {
      this.releaseMovement();
      return;
    }
    this.movement.delete(event.code);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) this.releaseMovement();
  };

  /** Drops every held key. The one recovery for a keyup that never arrived. */
  private releaseMovement = (): void => {
    this.movement.clear();
    this.boosting = false;
  };

  private resize = (): void => {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  };

  private updateMovement(delta: number): void {
    const desired = new THREE.Vector3();
    if (this.movement.size) {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
      if (this.movement.has("KeyW") || this.movement.has("ArrowUp")) desired.add(forward);
      if (this.movement.has("KeyS") || this.movement.has("ArrowDown")) desired.sub(forward);
      if (this.movement.has("KeyD") || this.movement.has("ArrowRight")) desired.add(right);
      if (this.movement.has("KeyA") || this.movement.has("ArrowLeft")) desired.sub(right);
      if (this.movement.has("KeyR")) desired.y += 1;
      if (this.movement.has("KeyF")) desired.y -= 1;
      if (desired.lengthSq()) {
        desired.normalize().multiplyScalar(BASE_SPEED * (this.boosting ? BOOST_MULTIPLIER : 1));
      }
    }
    // Frame-rate independent ease so the camera has weight instead of snapping.
    this.velocity.lerp(desired, 1 - Math.pow(0.0016, delta));
    if (this.velocity.lengthSq() < 1e-5) {
      this.velocity.set(0, 0, 0);
      return;
    }
    const step = this.velocity.clone().multiplyScalar(delta);
    this.camera.position.add(step);
    this.controls.target.add(step);
  }

  private animate = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (this.flight) {
      const elapsed = performance.now() - this.flight.startedAt;
      const progress = THREE.MathUtils.clamp(elapsed / this.flight.duration, 0, 1);
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      this.camera.position.lerpVectors(this.flight.fromPosition, this.flight.toPosition, eased);
      this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased);
      if (progress >= 1) {
        this.camera.position.copy(this.flight.toPosition);
        this.controls.target.copy(this.flight.toTarget);
        this.flight = null;
        this.controls.enabled = true;
      }
    } else {
      this.updateMovement(delta);
    }

    this.updateActivation(delta);
    if (this.intro && this.applyIntro(performance.now() - this.intro.startedAt)) this.finishIntro();
    // After the reveal, which owns the intro factor these fades multiply against.
    this.updateLabels(delta);
    // After the reveal, so the lift survives the intro's matrix rewrites.
    this.updateHoverHighlight(delta);
    this.updateAimBox(delta);

    this.grid.position.set(this.camera.position.x, GRID_Y, this.camera.position.z);
    this.gridMaterial.uniforms.uCamera.value.copy(this.camera.position);
    this.sky.position.copy(this.camera.position);

    if (this.selectionBox.visible) {
      (this.selectionBox.material as THREE.LineBasicMaterial).opacity = 0.72 + Math.sin(performance.now() * 0.006) * 0.22;
    }
    this.controls.update();
    if (performance.now() - this.lastAimCheck > 80) {
      this.lastAimCheck = performance.now();
      this.checkAreaEntry();
      this.updateAim();
    }
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  destroy(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.releaseMovement);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.disposeWorld();
    this.renderer.dispose();
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement;
}

const INACTIVE_OPACITY = 0.2;
const INACTIVE_EMISSIVE = 0.3;

function rememberActiveLook(material: THREE.MeshLambertMaterial): void {
  material.userData.activeColor = material.color.clone();
  // Dim and desaturate rather than crush to black, so visited areas stay readable.
  material.userData.inactiveColor = material.color.clone().multiplyScalar(0.34).lerp(new THREE.Color(0x0e1a1b), 0.4);
  material.userData.activeEmissiveIntensity = material.emissiveIntensity;
}

/**
 * The one place a label's opacity is written. Three independent factors multiply: how
 * far into the reveal it is, whether the camera currently has it selected for display,
 * and whether its district is the active one. Splitting them across the animation, the
 * label picker and the cross-fade is what made them fight each other.
 */
function writeLabelOpacity(sprite: THREE.Sprite, activation: number): void {
  const { introFade = 1, proximityFade = 1 } = sprite.material.userData;
  const opacity = introFade * proximityFade * THREE.MathUtils.lerp(INACTIVE_OPACITY, 1, activation);
  sprite.material.opacity = opacity;
  sprite.visible = opacity > 0.012;
}

/** `activation` blends continuously from the dimmed look (0) to the active look (1). */
function applyAreaLook(material: THREE.Material, activation: number): void {
  if (material instanceof THREE.MeshBasicMaterial && typeof material.userData.activeOpacity === "number") {
    material.opacity = material.userData.activeOpacity * THREE.MathUtils.lerp(INACTIVE_OPACITY, 1, activation);
  } else if (material instanceof THREE.MeshLambertMaterial) {
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    const active = material.userData.activeColor;
    const inactive = material.userData.inactiveColor;
    if (active instanceof THREE.Color && inactive instanceof THREE.Color) {
      material.color.copy(inactive).lerp(active, activation);
    }
    const activeIntensity = typeof material.userData.activeEmissiveIntensity === "number"
      ? material.userData.activeEmissiveIntensity
      : 0;
    material.emissiveIntensity = activeIntensity * THREE.MathUtils.lerp(INACTIVE_EMISSIVE, 1, activation);
  }
}
