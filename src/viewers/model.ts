import * as THREE from "three";
import { extensionOf } from "../filesystem";
import { el } from "./dom";
import type { ViewerHost } from "./types";

const PHOSPHOR = 0x86fadd;
const VOID = 0x081210;
/** The model is normalised into a box this many units across, so framing is universal. */
const FIT = 4;

export async function render(host: ViewerHost): Promise<void> {
  host.setMode("OBJECT INSPECTOR / MESH");
  const extension = extensionOf(host.node.name);
  const buffer = await (await host.blob()).arrayBuffer();
  if (host.signal.aborted) return;

  const object = await parse(extension, buffer);
  if (host.signal.aborted) {
    dispose(object);
    return;
  }

  const stage = el("div", "model-stage");
  const readout = el("p", "model-readout");
  const frame = el("figure", "model-view");
  frame.append(stage, readout);
  host.mount(frame);
  if (host.signal.aborted) {
    dispose(object);
    return;
  }

  mountViewport(stage, object, host);
  const triangles = countTriangles(object);
  readout.textContent = `${extension.toUpperCase()} MESH / ${triangles.toLocaleString()} TRIANGLES`;
  host.setStatus("MESH LOADED / DRAG TO ROTATE");
}

/** Each loader is imported on demand: opening an STL must not cost a GLTF parser. */
async function parse(extension: string, buffer: ArrayBuffer): Promise<THREE.Object3D> {
  if (extension === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    return new THREE.Mesh(new STLLoader().parse(buffer));
  }
  if (extension === "ply") {
    const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
    const geometry = new PLYLoader().parse(buffer);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry);
  }
  if (extension === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    return new OBJLoader().parse(new TextDecoder().decode(buffer));
  }
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  // An empty resource path keeps the loader from chasing sibling .bin/.png files it
  // cannot reach; self-contained .glb and data-URI .gltf still resolve.
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  return gltf.scene;
}

function mountViewport(stage: HTMLElement, object: THREE.Object3D, host: ViewerHost): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(VOID);
  scene.fog = new THREE.Fog(VOID, 12, 26);

  // One material for everything: source files carry textures we cannot resolve, and
  // the phosphor read is the point of the room. The wireframe is deliberately *un*lit:
  // lighting a one-pixel edge leaves it almost black against the void.
  const surface = new THREE.MeshStandardMaterial({ color: PHOSPHOR, roughness: 0.45, metalness: 0.15, flatShading: true });
  const wire = new THREE.MeshBasicMaterial({ color: 0xc8fff0, wireframe: true, transparent: true, opacity: 0.55 });
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.material = surface;
    meshes.push(child);
  });

  const pivot = new THREE.Group();
  const bounds = new THREE.Box3().setFromObject(object);
  const size = bounds.getSize(new THREE.Vector3());
  const scale = FIT / Math.max(size.x, size.y, size.z, 0.0001);
  object.position.sub(bounds.getCenter(new THREE.Vector3()));
  object.scale.setScalar(scale);
  object.position.multiplyScalar(scale);
  pivot.add(object);
  scene.add(pivot);

  const grid = new THREE.GridHelper(16, 16, 0xff5b82, 0x1c4a41);
  grid.position.y = -FIT / 2 - 0.4;
  scene.add(grid);
  scene.add(new THREE.HemisphereLight(0xbfffee, 0x0b1a18, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 6, 5);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  let distance = 9;
  let yaw = 0.7;
  let pitch = 0.5;
  let spin = true;

  const place = (): void => {
    camera.position.set(
      distance * Math.cos(pitch) * Math.sin(yaw),
      distance * Math.sin(pitch),
      distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(0, 0, 0);
  };

  let animation = 0;
  const tick = (): void => {
    animation = requestAnimationFrame(tick);
    if (spin) pivot.rotation.y += 0.004;
    place();
    renderer.render(scene, camera);
  };
  animation = requestAnimationFrame(tick);

  const observer = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  observer.observe(stage);

  const canvas = renderer.domElement;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    yaw -= (event.clientX - lastX) * 0.008;
    pitch = Math.max(-1.4, Math.min(1.4, pitch + (event.clientY - lastY) * 0.008));
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const release = (event: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    distance = Math.max(3, Math.min(24, distance + event.deltaY * 0.01));
  }, { passive: false });

  host.addToggle({
    label: (on) => `WIREFRAME: ${on ? "ON" : "OFF"}`,
    initial: false,
    onChange: (on) => {
      for (const mesh of meshes) mesh.material = on ? wire : surface;
    },
  });
  host.addToggle({
    label: (on) => `SPIN: ${on ? "ON" : "OFF"}`,
    initial: true,
    onChange: (on) => {
      spin = on;
    },
  });

  host.onCleanup(() => {
    cancelAnimationFrame(animation);
    observer.disconnect();
    dispose(object);
    surface.dispose();
    wire.dispose();
    grid.geometry.dispose();
    renderer.dispose();
    // Freeing the GL context matters: the world behind the dialog is holding one too.
    renderer.forceContextLoss();
    canvas.remove();
  });
}

function countTriangles(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    total += (geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3;
  });
  return Math.round(total);
}

function dispose(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
}
