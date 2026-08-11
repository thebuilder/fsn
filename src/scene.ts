import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { categoryOf, type FileCategory, type FsNode } from "./filesystem";

type SceneCallbacks = {
  onSelect: (node: FsNode | null) => void;
  onOpen: (node: FsNode) => void;
  onHover: (node: FsNode | null, x: number, y: number) => void;
  onAim: (node: FsNode | null) => void;
};

type Placement = {
  node: FsNode;
  position: THREE.Vector3;
  scale: THREE.Vector3;
};

export type NavigationDirection = "initial" | "forward" | "backward";

type DirectoryArea = {
  id: string;
  group: THREE.Group;
  center: THREE.Vector3;
  placements: Placement[];
  pickMeshes: Map<THREE.InstancedMesh, Placement[]>;
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
  image: 0xffb84a,
  audio: 0xb88cff,
  video: 0xff8656,
  document: 0x8bbfff,
  archive: 0xe6de6d,
  system: 0xff5a65,
  unknown: 0x899496,
};

function seededHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function buildPlacements(nodes: FsNode[], center: THREE.Vector3): Placement[] {
  const columns = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  return nodes.map((node, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const jitter = seededHash(node.id);
    const isDirectory = node.kind === "directory";
    const width = isDirectory ? 4.4 : 1.45 + (jitter % 4) * 0.1;
    const depth = isDirectory ? 3.6 : 1.45;
    const height = isDirectory
      ? 1.55 + Math.min(node.children?.length ?? 0, 12) * 0.07
      : Math.max(0.55, Math.min(7, Math.log2((node.size ?? 1_024) / 1024 + 1) * 0.62));
    const spacingX = 12;
    const spacingZ = 11;
    const lastRowCount = nodes.length - row * columns;
    const rowColumns = row === rows - 1 ? Math.min(columns, lastRowCount) : columns;
    const stagger = row % 2 === 0 ? 0 : 2.4;
    const x = center.x + (column - (rowColumns - 1) / 2) * spacingX + stagger;
    const z = center.z + (row - (rows - 1) / 2) * spacingZ;
    return {
      node,
      position: new THREE.Vector3(x, height / 2 + 0.28, z),
      scale: new THREE.Vector3(width, height, depth),
    };
  });
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
  private currentArea: DirectoryArea | null = null;
  private flight: CameraFlight | null = null;
  private hovered: FsNode | null = null;
  private aimed: Placement | null = null;
  private keyboardNavigationActive = false;
  private lastAimCheck = 0;
  private movement = new Set<string>();
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: SceneCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene.background = new THREE.Color(0x040708);
    this.scene.fog = new THREE.FogExp2(0x071a18, 0.018);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.03, 320);
    this.camera.position.set(0, 16, 30);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.target.set(0, 1.2, 6);
    this.controls.minDistance = 4;
    this.controls.maxDistance = 85;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

    this.scene.add(new THREE.HemisphereLight(0x94ffe5, 0x180611, 1.8));
    const key = new THREE.DirectionalLight(0xff7798, 3.1);
    key.position.set(-10, 18, -8);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x5fffe3, 32, 90, 1.7);
    rim.position.set(14, 10, 10);
    this.scene.add(rim);

    this.createEnvironment();
    this.scene.add(this.worldGroup);

    const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.08, 1.08, 1.08));
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
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    new ResizeObserver(this.resize).observe(canvas);
    this.animate();
  }

  setDirectory(directory: FsNode, nodes: FsNode[], direction: NavigationDirection): void {
    if (direction === "initial") this.disposeWorld();

    let area = this.areas.get(directory.id);
    if (!area) {
      const center = direction === "initial" ? new THREE.Vector3() : this.findNextAreaCenter(directory);
      area = this.createArea(directory.id, nodes, center);
      this.areas.set(directory.id, area);
      this.worldGroup.add(area.group);
    }

    this.setActiveArea(area);
    this.flyToArea(area.center, direction === "initial");
    this.selectionBox.visible = false;
    this.aimed = null;
    this.aimBox.visible = false;
    this.callbacks.onAim(null);
    this.callbacks.onSelect(null);
  }

  private createArea(id: string, nodes: FsNode[], center: THREE.Vector3): DirectoryArea {
    const group = new THREE.Group();
    group.userData.directoryArea = id;
    const placements = buildPlacements(nodes, center);
    const grouped = new Map<FileCategory, Placement[]>();
    placements.forEach((placement) => {
      const category = categoryOf(placement.node);
      grouped.set(category, [...(grouped.get(category) ?? []), placement]);
    });

    const pickMeshes = new Map<THREE.InstancedMesh, Placement[]>();
    const matrix = new THREE.Matrix4();
    for (const [category, categoryPlacements] of grouped) {
      const buildingMaterial = new THREE.MeshLambertMaterial({
        color: palette[category],
        emissive: palette[category],
        emissiveIntensity: category === "directory" ? 0.14 : 0.05,
      });
      buildingMaterial.userData.activeColor = buildingMaterial.color.getHex();
      buildingMaterial.userData.inactiveColor = buildingMaterial.color.clone().multiplyScalar(0.12).getHex();
      buildingMaterial.userData.activeEmissiveIntensity = buildingMaterial.emissiveIntensity;
      const buildingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMaterial, categoryPlacements.length);
      buildingMesh.frustumCulled = false;
      categoryPlacements.forEach((placement, index) => {
        matrix.compose(placement.position, new THREE.Quaternion(), placement.scale);
        buildingMesh.setMatrixAt(index, matrix);
      });
      buildingMesh.instanceMatrix.needsUpdate = true;
      buildingMesh.computeBoundingBox();
      buildingMesh.computeBoundingSphere();
      pickMeshes.set(buildingMesh, categoryPlacements);
      group.add(buildingMesh);

      const islandColor = category === "directory" ? 0x7d1734 : new THREE.Color(palette[category]).multiplyScalar(0.28).getHex();
      const islandMaterial = new THREE.MeshLambertMaterial({
        color: islandColor,
        emissive: islandColor,
        emissiveIntensity: 0.48,
      });
      islandMaterial.userData.activeColor = islandMaterial.color.getHex();
      islandMaterial.userData.inactiveColor = islandMaterial.color.clone().multiplyScalar(0.12).getHex();
      islandMaterial.userData.activeEmissiveIntensity = islandMaterial.emissiveIntensity;
      const islandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), islandMaterial, categoryPlacements.length);
      islandMesh.frustumCulled = false;
      categoryPlacements.forEach((placement, index) => {
        const isDirectory = placement.node.kind === "directory";
        const islandPosition = new THREE.Vector3(placement.position.x, -0.1, placement.position.z);
        const islandScale = new THREE.Vector3(isDirectory ? 9.2 : 5.4, isDirectory ? 0.48 : 0.36, isDirectory ? 7.2 : 5.4);
        matrix.compose(islandPosition, new THREE.Quaternion(), islandScale);
        islandMesh.setMatrixAt(index, matrix);
      });
      islandMesh.instanceMatrix.needsUpdate = true;
      islandMesh.computeBoundingBox();
      islandMesh.computeBoundingSphere();
      group.add(islandMesh);
    }

    placements.slice(0, 32).forEach((placement) => {
      const category = categoryOf(placement.node);
      const label = makeLabel(placement.node.name, `#${palette[category].toString(16).padStart(6, "0")}`);
      label.position.copy(placement.position).setY(placement.scale.y + 0.92);
      label.scale.set(placement.node.kind === "directory" ? 5.8 : 4.4, placement.node.kind === "directory" ? 1.08 : 0.82, 1);
      label.material.userData.activeOpacity = 1;
      group.add(label);
    });

    const beacon = new THREE.Mesh(new THREE.PlaneGeometry(48, 48), new THREE.MeshBasicMaterial({
      map: createGlowTexture(),
      color: 0x68ffda,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    beacon.position.set(center.x, -0.32, center.z);
    beacon.rotation.x = -Math.PI / 2;
    beacon.material.userData.activeOpacity = 0.22;
    group.add(beacon);

    return { id, group, center: center.clone(), placements, pickMeshes };
  }

  private findNextAreaCenter(directory: FsNode): THREE.Vector3 {
    const source = this.currentArea;
    if (!source) return new THREE.Vector3();
    const entrance = source.placements.find((placement) => placement.node.id === directory.id);
    const direction = entrance
      ? new THREE.Vector3().subVectors(entrance.position, source.center).setY(0)
      : new THREE.Vector3();
    if (direction.lengthSq() < 4) {
      const angle = (seededHash(directory.id) % 360) * (Math.PI / 180);
      direction.set(Math.cos(angle), 0, Math.sin(angle));
    }
    direction.normalize();
    return source.center.clone().add(direction.multiplyScalar(64));
  }

  private setActiveArea(area: DirectoryArea): void {
    this.currentArea = area;
    this.pickMeshes.clear();
    area.pickMeshes.forEach((placements, mesh) => this.pickMeshes.set(mesh, placements));
    this.areas.forEach((candidate) => {
      const isActive = candidate.id === area.id;
      candidate.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          if (material instanceof THREE.SpriteMaterial) {
            material.transparent = true;
            const activeOpacity = typeof material.userData.activeOpacity === "number" ? material.userData.activeOpacity : 1;
            material.opacity = isActive ? activeOpacity : activeOpacity * 0.2;
            material.depthWrite = false;
          } else if (material instanceof THREE.MeshBasicMaterial && typeof material.userData.activeOpacity === "number") {
            material.opacity = isActive ? material.userData.activeOpacity : material.userData.activeOpacity * 0.2;
          } else if (material instanceof THREE.MeshLambertMaterial) {
            material.transparent = false;
            material.opacity = 1;
            material.depthWrite = true;
            const color = isActive ? material.userData.activeColor : material.userData.inactiveColor;
            if (typeof color === "number") material.color.setHex(color);
            const activeIntensity = typeof material.userData.activeEmissiveIntensity === "number"
              ? material.userData.activeEmissiveIntensity
              : 0;
            material.emissiveIntensity = isActive ? activeIntensity : activeIntensity * 0.16;
          }
          material.needsUpdate = true;
        });
      });
    });
  }

  private flyToArea(center: THREE.Vector3, immediate: boolean): void {
    const toTarget = center.clone().add(new THREE.Vector3(0, 1.2, 0));
    const toPosition = center.clone().add(new THREE.Vector3(0, 17, 32));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (immediate || reducedMotion) {
      this.flight = null;
      this.camera.position.copy(toPosition);
      this.controls.target.copy(toTarget);
      this.controls.enabled = true;
      this.controls.update();
      return;
    }
    const distance = this.camera.position.distanceTo(toPosition);
    this.flight = {
      startedAt: performance.now(),
      duration: THREE.MathUtils.clamp(distance * 22, 1100, 2200),
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition,
      toTarget,
    };
    this.controls.enabled = false;
  }

  focusNode(node: FsNode): void {
    const placement = [...this.pickMeshes.values()].flat().find((candidate) => candidate.node.id === node.id);
    if (!placement) return;
    this.selectPlacement(placement);
    this.controls.target.copy(placement.position).setY(Math.max(1, placement.position.y));
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).add(direction.multiplyScalar(11));
  }

  getAimedNode(): FsNode | null {
    return this.aimed?.node ?? null;
  }

  setKeyboardNavigationActive(active: boolean): void {
    this.keyboardNavigationActive = active;
    this.aimBox.visible = active && Boolean(this.aimed);
  }

  selectAimed(): FsNode | null {
    if (!this.aimed) return null;
    this.selectPlacement(this.aimed);
    return this.aimed.node;
  }

  private createEnvironment(): void {
    const grid = new THREE.GridHelper(260, 130, 0x267e70, 0x16483f);
    grid.position.y = -0.34;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.32;
    this.scene.add(grid);

    const horizon = new THREE.Mesh(new THREE.CylinderGeometry(138, 138, 40, 64, 1, true), new THREE.MeshBasicMaterial({ color: 0x0f442f, side: THREE.BackSide, transparent: true, opacity: 0.18 }));
    horizon.position.y = 12;
    this.scene.add(horizon);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: createGlowTexture(), color: 0x75ffe0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.set(0, 12, -72);
    glow.scale.set(120, 55, 1);
    this.scene.add(glow);

    const starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(900);
    for (let index = 0; index < positions.length; index += 3) {
      positions[index] = (Math.random() - 0.5) * 260;
      positions[index + 1] = Math.random() * 75 + 4;
      positions[index + 2] = (Math.random() - 0.5) * 260;
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x83c9b8, size: 0.07, transparent: true, opacity: 0.55 })));
  }

  private disposeWorld(): void {
    this.pickMeshes.clear();
    this.areas.clear();
    this.currentArea = null;
    this.flight = null;
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
    if (nextAim?.node.id === this.aimed?.node.id) {
      this.aimBox.visible = this.keyboardNavigationActive && Boolean(nextAim);
      return;
    }
    this.aimed = nextAim;
    this.aimBox.visible = this.keyboardNavigationActive && Boolean(nextAim);
    if (nextAim) {
      this.aimBox.position.copy(nextAim.position);
      this.aimBox.scale.copy(nextAim.scale).multiplyScalar(1.14);
    }
    this.callbacks.onAim(nextAim?.node ?? null);
  }

  private selectPlacement(placement: Placement): void {
    this.selectionBox.visible = true;
    this.selectionBox.position.copy(placement.position);
    this.selectionBox.scale.copy(placement.scale).multiplyScalar(1.08);
    this.callbacks.onSelect(placement.node);
  }

  private onPointerMove = (event: PointerEvent): void => {
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit?.node.id !== this.hovered?.id) {
      this.hovered = hit?.node ?? null;
      this.canvas.style.cursor = hit ? "crosshair" : "grab";
    }
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
    if (hit) this.callbacks.onOpen(hit.node);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) return;
    if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      this.setKeyboardNavigationActive(true);
      this.movement.add(event.key.toLowerCase());
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.movement.delete(event.key.toLowerCase());
  };

  private resize = (): void => {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  };

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
    } else if (this.movement.size) {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
      const movement = new THREE.Vector3();
      if (this.movement.has("w") || this.movement.has("arrowup")) movement.add(forward);
      if (this.movement.has("s") || this.movement.has("arrowdown")) movement.sub(forward);
      if (this.movement.has("d") || this.movement.has("arrowright")) movement.add(right);
      if (this.movement.has("a") || this.movement.has("arrowleft")) movement.sub(right);
      if (movement.lengthSq()) {
        movement.normalize().multiplyScalar(delta * 12);
        this.camera.position.add(movement);
        this.controls.target.add(movement);
      }
    }
    if (this.selectionBox.visible) {
      (this.selectionBox.material as THREE.LineBasicMaterial).opacity = 0.72 + Math.sin(performance.now() * 0.006) * 0.22;
    }
    this.controls.update();
    if (performance.now() - this.lastAimCheck > 80) {
      this.lastAimCheck = performance.now();
      this.updateAim();
    }
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.disposeWorld();
    this.renderer.dispose();
  }
}
