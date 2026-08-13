import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { categoryOf, type FileCategory, type FsNode } from "@fsn/core";
import {
  buildLayout,
  GROUND_HEIGHT,
  GROUND_TOP,
  GROUND_Y,
  seededHash,
  type AreaLayout,
  type Decor,
  type Placement,
} from "./layout";

type SceneCallbacks = {
  onSelect: (node: FsNode | null) => void;
  onOpen: (node: FsNode) => void;
  onHover: (node: FsNode | null, x: number, y: number) => void;
  onAim: (node: FsNode | null) => void;
  onKeyboardNavigation: (active: boolean) => void;
  /** Alt is down: the fly and turn key clusters have traded jobs. */
  onSwapKeys: (swapped: boolean) => void;
  /** The camera flew into a directory the user had already visited. */
  onEnterArea: (directoryId: string) => void;
};

export type NavigationDirection = "initial" | "forward" | "backward";

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
  ease: (progress: number) => number;
  /** An establishing shot yields the moment a hand touches the controls. */
  interruptible: boolean;
};

/** Symmetric ease with no hard edge at either end: a camera on rails, not on a spring. */
function smootherstep(progress: number): number {
  return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

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

const RIM_OVERHANG = 1.1;
const RIM_HEIGHT = 0.22;
const GRID_Y = GROUND_Y - GROUND_HEIGHT / 2 - RIM_HEIGHT - 0.04;
const AREA_MARGIN = 22;

/**
 * Labels are the first thing to clutter a tight layout, so only the nearest few on
 * screen are drawn, re-picked as the camera moves. Sprites are built the first time a
 * label is chosen and cached: 250 of them up front is both a stall and a lot of texture
 * memory, and most of a large directory is never looked at closely.
 */
const LABEL_VISIBLE = 34;
const LABEL_MAX_DISTANCE = 150;
/** World size of a name plate at reading distance. Directories are the road signs. */
const LABEL_SIZE = {
  directory: { width: 5.2, height: 0.97 },
  file: { width: 3.1, height: 0.58 },
};
/**
 * A plate is sized for the distance it is read from. Held at a fixed world size it is
 * comfortable in the front rows and a smear of grey pixels at the back of a district,
 * so past `LABEL_READING_DISTANCE` it grows.
 *
 * The square root is the whole of the idea. Growing in exact proportion to distance
 * would hold a name at a constant size on screen, which reads as a HUD pinned over the
 * city rather than as something standing in it — and, worse, sorts the skyline by
 * nothing: every name equally loud, no clue which one is near enough to fly to. Half
 * the exponent gives back most of the lost pixels and still lets far read as far. The
 * cap lands where growth would otherwise start to outpace the gaps the layout leaves.
 */
const LABEL_READING_DISTANCE = 26;
const LABEL_MAX_SCALE = 2.4;
/** Directories are how you travel, so they outrank a file at the same distance. */
const LABEL_DIRECTORY_BONUS = 22;
const LABEL_SELECT_INTERVAL = 120;
/** Cap on canvases rasterised per pick, so flying fast staggers the work over frames. */
const LABEL_BUILDS_PER_TICK = 4;
const LABEL_CACHE_LIMIT = 128;
const EASE_LABEL = 0.000004;

const MOVE_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyR", "KeyF"]);
/**
 * The arrows turn rather than strafe. WASD already translates, so aliasing them was
 * spare, and without these the keyboard has no way at all to change where the camera
 * looks — every heading change needed a drag. Alt swaps the two clusters, so a hand
 * that would rather not leave WASD can turn from there, and one that has settled on
 * the arrows can still fly.
 */
const TURN_CODES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const BASE_SPEED = 20;
const BOOST_MULTIPLIER = 3.5;
const TURN_SPEED = 1.5;
const TURN_BOOST = 2;
/** Keeps a turn off both poles, where the offset has no azimuth left to rotate. */
const TURN_POLAR_MARGIN = 0.02;

/** A finger may drift this far, in CSS pixels, and still have meant to stand still. */
const TAP_SLOP = 12;
/** Longer than this is a press, not a tap, however still the finger was held. */
const TAP_HOLD_LIMIT = 500;
const DOUBLE_TAP_WINDOW = 400;
/** How far apart the two taps of a pair may land, in CSS pixels. */
const DOUBLE_TAP_RADIUS = 36;

/** Reveal: each object rises over INTRO_RISE, staggered outwards across INTRO_STAGGER. */
const INTRO_RISE = 420;
const INTRO_LABEL_FADE = 240;
/** How far ahead of its height an object's footprint opens: 4 means by the first quarter. */
const INTRO_SPREAD_LEAD = 4;

/**
 * The establishing shot, expressed against the framing pose the flight lands on: it
 * begins that many times further out, that much higher again, and swung round by
 * INTRO_SWING radians, so the descent has an arc in it rather than being a straight
 * dolly. Long enough that the skyline finishes rising well before the camera settles.
 *
 * Restrained on purpose. Opening much higher turns the shot into a satellite view of a
 * district too small to read, across a floor grid steep enough that its lines alias
 * against each other and crawl for the whole descent. This clears the skyline and keeps
 * the subject legible from the first frame.
 */
const INTRO_PULL_BACK = 1.75;
const INTRO_ALTITUDE = 0.72;
const INTRO_SWING = 0.42;
const INTRO_FLIGHT = 2600;

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
  // Sizing belongs to `placeLabel`, which owns it for the life of the sprite.
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
}

/** A label's footprint on screen, in normalised device coordinates. */
type LabelRect = { x: number; y: number; halfWidth: number; halfHeight: number };

/**
 * Plates are drawn with a transparent margin around the plate itself, so they may be
 * allowed to pass a little closer than their quads suggest before they read as touching.
 */
const LABEL_RECT_SLACK = 0.86;

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return Math.abs(a.x - b.x) < (a.halfWidth + b.halfWidth) * LABEL_RECT_SLACK
    && Math.abs(a.y - b.y) < (a.halfHeight + b.halfHeight) * LABEL_RECT_SLACK;
}

function labelSize(placement: Placement): { width: number; height: number } {
  return placement.node.kind === "directory" ? LABEL_SIZE.directory : LABEL_SIZE.file;
}

/** How much larger than its reading size a plate at `distance` is drawn. */
export function labelScaleFor(distance: number): number {
  return THREE.MathUtils.clamp(Math.sqrt(distance / LABEL_READING_DISTANCE), 1, LABEL_MAX_SCALE);
}

/**
 * Where a plate's middle sits once it has grown. Two things move with the scale, and
 * both are about staying attached to the right object:
 *
 * The plate keeps its foot at the height a plate has always sat at, so it grows upwards
 * into open sky. Grown about its middle it would creep down over the roof it names, and
 * the constant gap between a name and its roof is the thing that reads as ownership.
 *
 * The lane stagger stretches with it. That stagger is what keeps the rows of a block from
 * printing over each other, and a fixed one unit stops being enough the moment the plates
 * it separates are twice their drawn size.
 */
function labelCenterY(placement: Placement, height: number, scale: number): number {
  return placement.labelY + placement.labelLift * (scale - 1) + (height * (scale - 1)) / 2;
}

function placeLabel(sprite: THREE.Sprite, scale: number): void {
  const placement = sprite.userData.placement as Placement;
  const { width, height } = labelSize(placement);
  sprite.scale.set(width * scale, height * scale, 1);
  sprite.position.set(placement.position.x, labelCenterY(placement, height, scale), placement.position.z);
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
  private readonly lifecycle = new AbortController();
  private readonly resizeObserver: ResizeObserver;
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
  /** Shared by selectionBox and aimBox; EdgesGeometry copies what it needs from unitBox. */
  private readonly outlineGeometry: THREE.EdgesGeometry;
  private readonly selectionMaterial: THREE.LineBasicMaterial;
  private readonly aimMaterial: THREE.LineBasicMaterial;
  /** Every per-area mesh shares this unit cube, scaled per instance; disposeWorld must not free it. */
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  /** One glow canvas per scene instance, reused by every area's beacon. */
  private readonly glowTexture = createGlowTexture();
  private readonly clock = new THREE.Clock();
  private readonly keyLight: THREE.DirectionalLight;
  private readonly gridMaterial: THREE.ShaderMaterial;
  private readonly grid: THREE.Mesh;
  private readonly sky: THREE.Group;
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GRID_Y);
  private readonly movement = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  /** x is yaw, y is pitch, both in radians per second. */
  private readonly turnVelocity = new THREE.Vector2();
  private tapCandidate: { id: number; x: number; y: number; time: number } | null = null;
  /**
   * Where the primary pointer went down, of whatever kind. A press that comes back up
   * near where it started is a click; one that travels is the camera being moved.
   */
  private pressCandidate: { id: number; x: number; y: number } | null = null;
  private lastTap: { x: number; y: number; time: number } | null = null;
  private lastTapActivate = 0;
  private currentArea: DirectoryArea | null = null;
  private flight: CameraFlight | null = null;
  private intro: AreaIntro | null = null;
  private revealHeld = false;
  private hovered: FsNode | null = null;
  private aimed: Placement | null = null;
  private selected: Placement | null = null;
  /**
   * The world position an area held the instant it was surgically evicted, kept just
   * long enough for the area that replaces it to claim the same spot. Consumed once:
   * `setDirectory` reads and clears it, so a directory opened fresh later never
   * inherits a stale center meant for a different visit.
   */
  private invalidatedCenter: { id: string; center: THREE.Vector3 } | null = null;
  private keyboardNavigationActive = false;
  private boosting = false;
  /** Alt held: the fly keys point the camera and the arrows drive it, each other's job. */
  private swapped = false;
  private lastAimCheck = 0;
  private frame = 0;
  private pendingArea: DirectoryArea | null = null;
  private pendingSince = 0;
  private hoverTarget: Placement | null = null;
  private hoverShown: Placement | null = null;
  /** Latest pointermove position, resolved once per frame instead of once per event. */
  private pointerClient: { x: number; y: number } | null = null;
  private pointerDirty = false;
  /** Only changes when layout does; the ResizeObserver clears it when that happens. */
  private canvasRect: DOMRect | null = null;
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
  private readonly labelForward = new THREE.Vector3();
  private labelCandidates: { placement: Placement; area: DirectoryArea; score: number; distance: number }[] = [];
  /** Screen boxes already claimed by this pick, in NDC. Rebuilt every pick. */
  private readonly labelRects: LabelRect[] = [];
  private lastLabelSelect = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: SceneCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    /**
     * The buffer has to land on the display's pixel grid rather than between it. At 1.5
     * on a 2x screen every frame is stretched by a third on its way to the glass, and
     * resampling a moving image is what makes a slow camera shimmer: grid lines, tower
     * edges and outlines are all about a pixel wide, so each one redistributes its
     * brightness across a different pair of device pixels every frame and crawls.
     *
     * Matching the device ratio is 1:1 on every common display and costs the fill rate
     * that buys back. The cap is for the 3x screens, where 1:1 is not worth its price.
     */
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

    this.outlineGeometry = new THREE.EdgesGeometry(this.unitBox);
    this.selectionMaterial = new THREE.LineBasicMaterial({ color: 0xf4ffd9, transparent: true, opacity: 0.95 });
    this.selectionBox = new THREE.LineSegments(this.outlineGeometry, this.selectionMaterial);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);
    this.aimMaterial = new THREE.LineBasicMaterial({ color: 0x7fffe0, transparent: true, opacity: 0.5 });
    this.aimBox = new THREE.LineSegments(this.outlineGeometry, this.aimMaterial);
    this.aimBox.visible = false;
    this.scene.add(this.aimBox);

    const listener = { signal: this.lifecycle.signal };
    this.canvas.addEventListener("pointermove", this.onPointerMove, listener);
    this.canvas.addEventListener("pointerdown", this.onPointerDown, listener);
    this.canvas.addEventListener("pointerup", this.onPointerUp, listener);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel, listener);
    // Captured on the window, which is the only place that reliably runs before the
    // controls' own listener on the canvas: handing the controls back first is what
    // lets the gesture that ends the establishing shot also orbit, rather than being
    // spent on stopping the camera.
    window.addEventListener("pointerdown", this.takeOverFlight, { capture: true, signal: this.lifecycle.signal });
    window.addEventListener("wheel", this.takeOverFlight, { capture: true, passive: true, signal: this.lifecycle.signal });
    this.canvas.addEventListener("dblclick", this.onDoubleClick, listener);
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault(), listener);
    // Capture phase: a key release must reach us even if something nearer the target
    // stops the event, or the camera would keep drifting with nothing to cancel it.
    window.addEventListener("keydown", this.onKeyDown, { capture: true, signal: this.lifecycle.signal });
    window.addEventListener("keyup", this.onKeyUp, { capture: true, signal: this.lifecycle.signal });
    window.addEventListener("blur", this.releaseMovement, listener);
    document.addEventListener("visibilitychange", this.onVisibilityChange, listener);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas);
    this.animate();
  }

  setDirectory(directory: FsNode, nodes: FsNode[], direction: NavigationDirection): void {
    if (direction === "initial") this.disposeWorld();

    let area = this.areas.get(directory.id);
    let isNew = false;
    if (!area) {
      const layout = buildLayout(nodes);
      // A directory just surgically evicted by `invalidateArea` rebuilds exactly where
      // it stood, not wherever `findAreaCenter` would otherwise place a fresh arrival.
      const reclaimed = this.invalidatedCenter?.id === directory.id ? this.invalidatedCenter.center : null;
      this.invalidatedCenter = null;
      const center = reclaimed ?? (direction === "initial" ? new THREE.Vector3() : this.findAreaCenter(directory, layout.radius));
      area = this.createArea(directory.id, center, layout);
      this.areas.set(directory.id, area);
      this.worldGroup.add(area.group);
      isNew = true;
    }

    this.setActiveArea(area);
    // Only reveal on first build; re-entering a known directory should not replay it.
    if (isNew) this.startIntro(area);
    // A new filesystem is an arrival, so it gets the establishing shot; moving within
    // one is navigation, and travels at the pace the person is already moving at.
    this.flyToArea(area, direction === "initial" ? "establish" : "travel");
    this.clearSelectionAndAim();
  }

  /**
   * Surgically forgets one directory's built geometry, so the next `setDirectory` call
   * for the same id reads as a fresh arrival and rebuilds it from scratch. Every other
   * area in the world is untouched — this is the opposite of `disposeWorld`, which
   * tears the whole scene down.
   *
   * The evicted area's center is banked in `invalidatedCenter` so the rebuild lands
   * exactly where this one stood rather than being placed anew relative to whatever
   * `findAreaCenter` would otherwise consider "current".
   */
  invalidateArea(directoryId: string): void {
    const area = this.areas.get(directoryId);
    if (!area) return;

    area.pickMeshes.forEach((_placements, mesh) => this.pickMeshes.delete(mesh));
    this.disposeAreaObjects(area.group);
    this.worldGroup.remove(area.group);
    this.areas.delete(directoryId);
    this.invalidatedCenter = { id: directoryId, center: area.center.clone() };

    if (this.intro?.area === area) this.intro = null;
    if (this.pendingArea === area) this.pendingArea = null;
    if (this.currentArea === area) this.currentArea = null;
    if (this.hoverTarget && area.placements.includes(this.hoverTarget)) this.hoverTarget = null;
    if (this.hoverShown && area.placements.includes(this.hoverShown)) {
      this.hoverShown = null;
      this.hoverStrength = 0;
    }
    if (this.hovered && area.placements.some((placement) => placement.node.id === this.hovered?.id)) {
      this.hovered = null;
      this.callbacks.onHover(null, 0, 0);
    }
    if (this.aimed && area.placements.includes(this.aimed)) {
      this.aimed = null;
      this.aimBox.visible = false;
      this.callbacks.onAim(null);
    }
    if (this.selected && area.placements.includes(this.selected)) {
      this.selected = null;
      this.selectionBox.visible = false;
      this.callbacks.onSelect(null);
    }
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
    const rim = new THREE.Mesh(this.unitBox, rimMaterial);
    rim.scale.set(layout.groundWidth + RIM_OVERHANG * 2, RIM_HEIGHT, layout.groundDepth + RIM_OVERHANG * 2);
    rim.position.set(center.x, GROUND_Y - GROUND_HEIGHT / 2 - RIM_HEIGHT / 2, center.z);
    group.add(rim);

    const groundMaterial = new THREE.MeshLambertMaterial({ color: GROUND_COLOR, emissive: GROUND_COLOR, emissiveIntensity: 0.16 });
    rememberActiveLook(groundMaterial);
    materials.push(groundMaterial);
    const ground = new THREE.Mesh(this.unitBox, groundMaterial);
    ground.scale.set(layout.groundWidth, GROUND_HEIGHT, layout.groundDepth);
    ground.position.set(center.x, GROUND_Y, center.z);
    ground.receiveShadow = true;
    group.add(ground);

    const grouped = new Map<FileCategory, Placement[]>();
    placements.forEach((placement) => {
      const category = categoryOf(placement.node);
      const bucket = grouped.get(category);
      if (bucket) bucket.push(placement);
      else grouped.set(category, [placement]);
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
      const buildingMesh = new THREE.InstancedMesh(this.unitBox, buildingMaterial, categoryPlacements.length);
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
      const markerMesh = new THREE.InstancedMesh(this.unitBox, markerMaterial, markers.length);
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
      map: this.glowTexture,
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
        // Every frame, not every pick: the size follows the camera continuously, and a
        // plate that resized in 120ms steps would visibly tick as you fly at it.
        if (sprite.visible) this.sizeLabel(sprite);
      });
    });
  }

  /** Draws a plate at the size its current distance from the camera asks for. */
  private sizeLabel(sprite: THREE.Sprite): void {
    const placement = sprite.userData.placement as Placement;
    this.labelPoint.set(placement.position.x, placement.labelY, placement.position.z);
    placeLabel(sprite, labelScaleFor(this.camera.position.distanceTo(this.labelPoint)));
  }

  /**
   * Chooses the nearest labels that are actually on screen, nearest first, and gives each
   * winner the screen space it occupies. Nearest-first is what makes the claim fair: the
   * name you are closest to is the one you are most likely reading, and it takes the spot
   * from anything behind it rather than sharing it. Without this the growth would buy
   * legibility in one row and spend it printing the next row through it — a plate is
   * already about as wide as the gap between two towers, so there is no slack to grow into.
   */
  private selectLabels(now: number): void {
    this.labelViewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.labelFrustum.setFromProjectionMatrix(this.labelViewProjection);
    this.camera.getWorldDirection(this.labelForward);

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
        candidates.push({ placement, area, score: distance - bonus, distance });
      }
    });
    candidates.sort((a, b) => a.score - b.score);

    const claimed = this.labelRects;
    claimed.length = 0;
    const shown = new Set<Placement>();
    let built = 0;
    for (const candidate of candidates) {
      if (shown.size >= LABEL_VISIBLE) break;
      const rect = this.labelRect(candidate.placement, candidate.distance);
      if (!rect || claimed.some((other) => rectsOverlap(rect, other))) continue;
      // Claimed before the build budget is checked, so a name that has won its space keeps
      // it while its canvas waits for a later frame. Handing the spot to whatever is behind
      // it in the meantime would show that one for a tick and then take it away again.
      claimed.push(rect);
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

  /**
   * The box a plate would cover on screen, in normalised device coordinates. Measured
   * rather than rasterised: the size is a pure function of distance, so a candidate can
   * be laid out and turned down before its canvas is ever drawn.
   */
  private labelRect(placement: Placement, distance: number): LabelRect | null {
    const scale = labelScaleFor(distance);
    const { width, height } = labelSize(placement);
    this.labelPoint.set(placement.position.x, labelCenterY(placement, height, scale), placement.position.z);
    // Depth along the view axis, not distance from the eye: that is what perspective
    // divides by, and at the edges of a 52° view the two are far enough apart to matter.
    const depth = this.scratchVector.subVectors(this.labelPoint, this.camera.position).dot(this.labelForward);
    if (depth <= this.camera.near) return null;
    const halfFrustum = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * depth;
    const ndc = this.labelPoint.project(this.camera);
    return {
      x: ndc.x,
      y: ndc.y,
      halfWidth: (width * scale) / (2 * halfFrustum * this.camera.aspect),
      halfHeight: (height * scale) / (2 * halfFrustum),
    };
  }

  private buildLabel(placement: Placement, area: DirectoryArea): THREE.Sprite {
    const color = palette[categoryOf(placement.node)];
    const sprite = makeLabel(placement.node.name, `#${color.toString(16).padStart(6, "0")}`);
    sprite.userData.placement = placement;
    this.sizeLabel(sprite);
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

  /** Puts the selection down and leaves the aim alone; that one belongs to the keyboard. */
  private clearSelection(): void {
    if (!this.selectionBox.visible) return;
    this.selectionBox.visible = false;
    this.callbacks.onSelect(null);
  }

  private clearSelectionAndAim(): void {
    this.selectionBox.visible = false;
    this.selected = null;
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
  private flyToArea(area: DirectoryArea, arrival: "travel" | "establish"): void {
    const distance = Math.max(22, area.radius * 1.7, area.peakHeight * 3.6);
    const toTarget = area.center.clone().add(new THREE.Vector3(0, area.peakHeight * 0.3, 0));
    const toPosition = area.center.clone().add(new THREE.Vector3(0, distance * 0.68, distance));
    if (arrival === "travel") {
      this.flyTo(toTarget, toPosition);
      return;
    }
    // Open wide and high, off to one side, looking down at where the district will be;
    // the flight then falls into the framing pose as the last towers finish rising.
    const reach = distance * INTRO_PULL_BACK;
    this.camera.position.copy(area.center).add(
      new THREE.Vector3(Math.sin(INTRO_SWING) * reach, reach * INTRO_ALTITUDE, Math.cos(INTRO_SWING) * reach),
    );
    this.controls.target.copy(area.center).add(new THREE.Vector3(0, area.peakHeight * 1.1, 0));
    // The pose is teleported into, so it has to aim itself: the controls are what
    // normally keep the camera pointed at the target, and they stand down for flights.
    this.camera.lookAt(this.controls.target);
    this.flyTo(toTarget, toPosition, { duration: INTRO_FLIGHT, ease: smootherstep, interruptible: true });
  }

  private flyTo(
    toTarget: THREE.Vector3,
    toPosition: THREE.Vector3,
    options: { duration?: number; ease?: (progress: number) => number; interruptible?: boolean } = {},
  ): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
      duration: options.duration ?? THREE.MathUtils.clamp(distance * 12, 350, 1400),
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition,
      toTarget,
      ease: options.ease ?? easeInOutCubic,
      interruptible: options.interruptible ?? false,
    };
    this.controls.enabled = false;
  }

  private advanceFlight(): void {
    const flight = this.flight;
    if (!flight) return;
    const progress = THREE.MathUtils.clamp((performance.now() - flight.startedAt) / flight.duration, 0, 1);
    const eased = flight.ease(progress);
    this.camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
    this.camera.lookAt(this.controls.target);
    if (progress < 1) return;
    this.camera.position.copy(flight.toPosition);
    this.controls.target.copy(flight.toTarget);
    this.flight = null;
    this.controls.enabled = true;
  }

  private cancelFlight(): void {
    if (!this.flight) return;
    this.flight = null;
    this.controls.enabled = true;
  }

  /**
   * Freezes the reveal that is about to be built at frame zero. The welcome screen sits
   * over the world it is offering, and a skyline that rose and a camera that landed
   * behind a blurred backdrop is a reveal nobody saw.
   */
  holdReveal(): void {
    this.revealHeld = true;
  }

  /** Runs whatever was held, from the top. Safe to call when nothing is holding. */
  releaseReveal(): void {
    if (!this.revealHeld) return;
    this.revealHeld = false;
    const now = performance.now();
    if (this.intro) this.intro.startedAt = now;
    if (this.flight) this.flight.startedAt = now;
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
      // The footprint opens ahead of the height, and from nothing. A box with no height
      // still shows its whole top face to a camera looking down at it, so an unopened
      // district read as its own floor plan: every plot and marker laid out flat, the
      // answer printed above the reveal that is about to give it.
      const spread = Math.max(Math.min(eased * INTRO_SPREAD_LEAD, 1), 0.0001);
      if (placement.mesh && placement.instanceIndex !== undefined) {
        position.set(placement.position.x, GROUND_TOP + height / 2, placement.position.z);
        scale.set(placement.scale.x * spread, height, placement.scale.z * spread);
        matrix.compose(position, rotation, scale);
        placement.mesh.setMatrixAt(placement.instanceIndex, matrix);
      }
      // Markers grow on the plot's rising surface, so a plot never sprouts through them.
      placement.decor.forEach((decor) => {
        if (!decor.mesh || decor.instanceIndex === undefined) return;
        const markerHeight = Math.max(decor.scale.y * eased, 0.0001);
        position.set(decor.position.x, GROUND_TOP + height + markerHeight / 2, decor.position.z);
        scale.set(decor.scale.x * spread, markerHeight, decor.scale.z * spread);
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
    if (this.currentArea) this.flyToArea(this.currentArea, "travel");
  }

  getAimedNode(): FsNode | null {
    return this.aimed?.node ?? null;
  }

  /** Announced rather than read, so the on-screen legend can say what the keys do now. */
  private setSwapped(swapped: boolean): void {
    if (this.swapped === swapped) return;
    this.swapped = swapped;
    this.callbacks.onSwapKeys(swapped);
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
      // Unattenuated point size is buffer pixels, not screen pixels, so it has to be
      // told the ratio: otherwise a sharper buffer quietly shrinks the sky to specks.
      size: 1.3 * this.renderer.getPixelRatio(),
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
      this.disposeAreaObjects(object);
    }
  }

  /**
   * Frees every mesh/line/sprite geometry and material under `object`, respecting the
   * resources shared across every area: `unitBox` (every plot and marker instances it)
   * and `glowTexture` (every area's beacon reuses the one canvas). Shared by
   * `disposeWorld`, which tears down the whole scene, and `invalidateArea`, which frees
   * a single area's group without touching any other.
   */
  private disposeAreaObjects(object: THREE.Object3D): void {
    object.traverse((descendant) => {
      if (!(descendant instanceof THREE.Mesh || descendant instanceof THREE.Line || descendant instanceof THREE.Sprite)) return;
      if (descendant.geometry && descendant.geometry !== this.unitBox) descendant.geometry.dispose();
      const materials = Array.isArray(descendant.material) ? descendant.material : [descendant.material];
      materials.forEach((material) => {
        const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
        if (map && map !== this.glowTexture) map.dispose();
        material.dispose();
      });
    });
  }

  private hitTest(clientX: number, clientY: number): Placement | null {
    // The rect only changes when layout does, and the ResizeObserver already fires then.
    this.canvasRect ??= this.canvas.getBoundingClientRect();
    const rect = this.canvasRect;
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
    this.selected = placement;
    this.selectionBox.visible = true;
    this.selectionBox.position.copy(placement.outlinePosition);
    this.selectionBox.scale.copy(placement.outlineScale).multiplyScalar(1.06);
    this.callbacks.onSelect(placement.node);
  }

  // Pointermove can arrive at up to ~120/s, well past the render rate; recording the
  // latest position and resolving it once per frame (see `resolveHover`) makes hover
  // cost one raycast per frame, like aim already does.
  private onPointerMove = (event: PointerEvent): void => {
    this.pointerClient = { x: event.clientX, y: event.clientY };
    this.pointerDirty = true;
  };

  /**
   * Resolves the latest recorded pointermove into a hover state. Split out of
   * `onPointerMove` so the per-event handler stays a cheap store, with the actual
   * raycast paid for once per frame in `animate` instead of once per event.
   */
  private resolveHover(): void {
    if (!this.pointerClient) return;
    const { x, y } = this.pointerClient;
    const hit = this.hitTest(x, y);
    if (hit?.node.id !== this.hovered?.id) {
      this.hovered = hit?.node ?? null;
      this.canvas.style.cursor = hit ? "crosshair" : "grab";
    }
    this.hoverTarget = hit;
    this.callbacks.onHover(hit?.node ?? null, x, y);
  }

  /**
   * Ends an establishing shot the moment the view is touched. Flights that did not offer
   * to be interrupted — travelling somewhere the user asked to go — are left to finish.
   */
  private takeOverFlight = (event: Event): void => {
    if (this.flight?.interruptible && event.target === this.canvas) this.cancelFlight();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    // A second finger is a pinch or a two-finger pan, and neither is half of a tap; it
    // arrives non-primary, which also drops any tap the first finger had going. Asking
    // the browser rather than counting pointers ourselves means a pointerup lost to a
    // gesture the browser swallowed cannot leave taps broken until the next reload.
    this.tapCandidate = event.isPrimary && event.pointerType !== "mouse"
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }
      : null;
    this.pressCandidate = event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    this.setKeyboardNavigationActive(false);
    this.canvas.focus({ preventScroll: true });
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit) this.selectPlacement(hit);
  };

  /**
   * Recognises a double tap by hand. Touch browsers do not agree on `dblclick`: iOS
   * never sends one, and where it does arrive it is late and easily lost to the pan
   * gesture, so the second tap has to be spotted from the pointer stream itself.
   */
  private onPointerUp = (event: PointerEvent): void => {
    const candidate = this.tapCandidate;
    const press = this.pressCandidate;
    this.tapCandidate = null;
    this.pressCandidate = null;
    // Nothing under a finger stays hovered once the finger is gone; there is no cursor
    // left to justify the lift, and the label would sit there over empty ground.
    if (event.pointerType !== "mouse" && this.hoverTarget) {
      this.hovered = null;
      this.hoverTarget = null;
      // Also drop the pending pointermove, or the next frame's resolveHover would
      // resurrect the hover this finger-lift just cleared.
      this.pointerClient = null;
      this.pointerDirty = false;
      this.callbacks.onHover(null, event.clientX, event.clientY);
    }
    // Empty ground is what a selection is put down on. It is decided here rather than on
    // the way down, because the same press begun on nothing is also how the camera is
    // orbited, and a view being turned is not a choice being unmade.
    if (
      press
      && press.id === event.pointerId
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_SLOP
      && !this.hitTest(event.clientX, event.clientY)
    ) {
      this.clearSelection();
    }
    if (!candidate || candidate.id !== event.pointerId) return;
    if (event.timeStamp - candidate.time > TAP_HOLD_LIMIT) return;
    if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > TAP_SLOP) return;

    const previous = this.lastTap;
    this.lastTap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    if (!previous || event.timeStamp - previous.time > DOUBLE_TAP_WINDOW) return;
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > DOUBLE_TAP_RADIUS) return;
    // A pair is spent once it fires, so a third tap opens a fresh one rather than
    // making every tap after the first count as another double.
    this.lastTap = null;
    this.lastTapActivate = event.timeStamp;
    this.activateAt(event.clientX, event.clientY);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.tapCandidate?.id === event.pointerId) this.tapCandidate = null;
    if (this.pressCandidate?.id === event.pointerId) this.pressCandidate = null;
  };

  private onDoubleClick = (event: MouseEvent): void => {
    // Some touch browsers do synthesise a dblclick, arriving after the taps it was
    // built from have already been acted on. Opening the same thing twice is at best
    // a wasted flight, so the synthetic one is dropped.
    if (event.timeStamp - this.lastTapActivate < DOUBLE_TAP_WINDOW * 2) return;
    this.activateAt(event.clientX, event.clientY);
  };

  /** Opens whatever is under the point, or travels there if that is bare ground. */
  private activateAt(clientX: number, clientY: number): void {
    const hit = this.hitTest(clientX, clientY);
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
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.boosting = event.shiftKey;
    this.setSwapped(event.altKey);
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
    if (!MOVE_CODES.has(event.code) && !TURN_CODES.has(event.code)) return;
    event.preventDefault();
    this.setKeyboardNavigationActive(true);
    this.movement.add(event.code);
    this.cancelFlight();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.boosting = event.shiftKey;
    this.setSwapped(event.altKey);
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
    this.setSwapped(false);
  };

  private resize = (): void => {
    // The cached rect in `hitTest` is only valid until layout changes; the
    // ResizeObserver that calls `resize` is exactly the signal that it has.
    this.canvasRect = null;
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
      // Alt swaps the two clusters outright, so whichever one is not turning is here.
      const held = (fly: string, arrow: string): boolean => this.movement.has(this.swapped ? arrow : fly);
      if (held("KeyW", "ArrowUp")) desired.add(forward);
      if (held("KeyS", "ArrowDown")) desired.sub(forward);
      if (held("KeyD", "ArrowRight")) desired.add(right);
      if (held("KeyA", "ArrowLeft")) desired.sub(right);
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

  /**
   * Swings the view by walking the orbit target around a camera that stays put — the
   * keyboard's only way to change heading, since the controls read the pose back off
   * these two points every frame. Driven by the arrows, or by the fly keys while Alt
   * has the two clusters swapped.
   */
  private updateTurn(delta: number): void {
    let yaw = 0;
    let pitch = 0;
    const held = (arrow: string, fly: string): boolean => this.movement.has(this.swapped ? fly : arrow);
    if (held("ArrowLeft", "KeyA")) yaw += 1;
    if (held("ArrowRight", "KeyD")) yaw -= 1;
    if (held("ArrowUp", "KeyW")) pitch += 1;
    if (held("ArrowDown", "KeyS")) pitch -= 1;
    const rate = TURN_SPEED * (this.boosting ? TURN_BOOST : 1);
    // The same ease the fly keys have, so starting and stopping a turn has weight too.
    const step = 1 - Math.pow(0.0016, delta);
    this.turnVelocity.x += (yaw * rate - this.turnVelocity.x) * step;
    this.turnVelocity.y += (pitch * rate - this.turnVelocity.y) * step;
    if (this.turnVelocity.lengthSq() < 1e-6) {
      this.turnVelocity.set(0, 0);
      return;
    }

    turnTarget(
      this.camera.position,
      this.controls.target,
      this.turnVelocity.x * delta,
      this.turnVelocity.y * delta,
      this.controls.minPolarAngle,
      this.controls.maxPolarAngle,
    );
  }

  private animate = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    // A held reveal keeps its opening frame: the flight stays parked at its wide pose
    // and the towers stay flat until whatever is covering them gets out of the way.
    if (!this.flight) {
      this.updateTurn(delta);
      this.updateMovement(delta);
    } else if (!this.revealHeld) this.advanceFlight();

    this.updateActivation(delta);
    if (this.intro && !this.revealHeld && this.applyIntro(performance.now() - this.intro.startedAt)) this.finishIntro();
    // After the reveal, which owns the intro factor these fades multiply against.
    this.updateLabels(delta);
    // Coalesces every pointermove since the last frame into one raycast, the way the
    // 80 ms aim gate below already coalesces mousemove; the hover cross-fade hides the
    // at-most-one-frame latency this adds.
    if (this.pointerDirty && this.pointerClient) {
      this.pointerDirty = false;
      this.resolveHover();
    }
    // After the reveal, so the lift survives the intro's matrix rewrites.
    this.updateHoverHighlight(delta);
    this.updateAimBox(delta);

    this.grid.position.set(this.camera.position.x, GRID_Y, this.camera.position.z);
    this.gridMaterial.uniforms.uCamera.value.copy(this.camera.position);
    this.sky.position.copy(this.camera.position);

    if (this.selectionBox.visible) {
      (this.selectionBox.material as THREE.LineBasicMaterial).opacity = 0.72 + Math.sin(performance.now() * 0.006) * 0.22;
    }
    // A flight owns the camera outright. `update()` ignores `enabled` — every call
    // re-derives the position from its own spherical state, clamps the radius to
    // `maxDistance` and the pitch to `maxPolarAngle`, and bleeds off leftover damping,
    // all of it written over the pose the flight just set. Letting it run alongside a
    // long approach is a tug of war, and the further out the shot opens the harder it
    // pulls. It picks the camera back up on the first frame after the flight lands.
    if (!this.flight) this.controls.update();
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
    this.lifecycle.abort();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.disposeWorld();
    // Environment and outline resources live outside worldGroup, so disposeWorld never
    // reaches them; everything per-scene-instance is freed here, shared resources last.
    this.grid.geometry.dispose();
    this.gridMaterial.dispose();
    this.sky.traverse((descendant) => {
      if (!(descendant instanceof THREE.Points)) return;
      descendant.geometry.dispose();
      const materials = Array.isArray(descendant.material) ? descendant.material : [descendant.material];
      materials.forEach((material) => material.dispose());
    });
    this.outlineGeometry.dispose();
    this.selectionMaterial.dispose();
    this.aimMaterial.dispose();
    this.unitBox.dispose();
    this.glowTexture.dispose();
    this.renderer.dispose();
  }
}

const TURN_OFFSET = new THREE.Vector3();
const TURN_SPHERICAL = new THREE.Spherical();

/**
 * Rotates `target` about a camera that stays where it is, by `yaw` and `pitch` radians,
 * and writes the result back into `target`.
 *
 * Pitch is held inside the same polar band a drag is held to — a positive pitch lays the
 * offset flatter, which raises the target towards the camera's own height, and from
 * behind the lens that reads as tilting up. Past the band the controls would snap the
 * camera on their next update, so the turn stops where a drag would.
 */
export function turnTarget(
  cameraPosition: THREE.Vector3,
  target: THREE.Vector3,
  yaw: number,
  pitch: number,
  minPolarAngle: number,
  maxPolarAngle: number,
): THREE.Vector3 {
  TURN_OFFSET.subVectors(cameraPosition, target);
  TURN_SPHERICAL.setFromVector3(TURN_OFFSET);
  TURN_SPHERICAL.theta += yaw;
  TURN_SPHERICAL.phi = THREE.MathUtils.clamp(
    TURN_SPHERICAL.phi + pitch,
    minPolarAngle + TURN_POLAR_MARGIN,
    maxPolarAngle - TURN_POLAR_MARGIN,
  );
  TURN_OFFSET.setFromSpherical(TURN_SPHERICAL);
  return target.subVectors(cameraPosition, TURN_OFFSET);
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
