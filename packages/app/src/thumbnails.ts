import * as THREE from "three";
import { categoryOf, extensionOf, type FsNode } from "@fsn/core";
import type { Placement } from "./layout";

/**
 * Pictures on the roofs of image towers. A folder of photographs is the one place the
 * city can show what a file is rather than only what kind it is, so each image in the
 * active district gets a small copy of itself laid on its roof, faded in once decoded.
 *
 * Every byte arrives through the same read path the viewer uses and is decoded only by
 * `createImageBitmap`, which rasterises off the main thread, never runs script and never
 * touches the DOM: an image from disk is untrusted input and is only ever pixels here.
 * The work is bounded on every axis a large folder could push: a few decodes at a time,
 * a cap per district, a size limit per file, and everything in flight dropped the moment
 * the view moves on.
 */

export type ReadFile = (node: FsNode, signal: AbortSignal) => Promise<Blob>;

/** Longest edge of a decoded thumbnail, in pixels. A roof is never more than this on screen. */
export const THUMBNAIL_EDGE = 128;
/** Decodes in flight at once. Two keeps the pipeline busy without starving the frame. */
export const THUMBNAIL_CONCURRENCY = 2;
/** The most roofs one district will dress; the nearest win. */
export const THUMBNAIL_LIMIT = 48;
/** A file bigger than this costs more to read than a thumbnail is worth. */
export const THUMBNAIL_MAX_BYTES = 20 * 1024 * 1024;
/**
 * Formats `createImageBitmap` will not take from a blob, so reading them is wasted work.
 * SVG in particular has to be rendered by a document to become pixels, and a document is
 * exactly what untrusted bytes must not be handed.
 */
const UNDECODABLE = new Set(["svg", "tif", "tiff"]);
/** How much of the roof the picture covers; the rest is left as a frame in the tower's colour. */
const ROOF_COVER = 0.84;
/** Clears the roof by enough to never fight it for depth, however far away it is seen. */
const ROOF_CLEARANCE = 0.02;
const FADE_IN = 420;
/** White, as a picture shows it: 83% of the display's own, just below where the glow starts. */
const PICTURE_TINT = 0xd4d4d4;
/** A picture in a background district keeps this much of itself, like the towers dimming under it. */
const INACTIVE_OPACITY = 0.3;

/** Whether a file is worth reading for a thumbnail at all. */
export function wantsThumbnail(node: FsNode): boolean {
  if (node.kind !== "file" || categoryOf(node) !== "image") return false;
  if (UNDECODABLE.has(extensionOf(node.name))) return false;
  return node.size === undefined || node.size <= THUMBNAIL_MAX_BYTES;
}

/**
 * The images of a district worth dressing, nearest to `from` first and cut at the cap.
 * Nearest first because the cap and the queue both favour the front: what is closest is
 * what is being looked at, and what is furthest may never be seen large enough to matter.
 */
export function thumbnailCandidates(placements: readonly Placement[], from: THREE.Vector3, limit = THUMBNAIL_LIMIT): Placement[] {
  return placements
    .filter((placement) => wantsThumbnail(placement.node))
    .map((placement) => ({ placement, distance: placement.position.distanceToSquared(from) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.placement);
}

/**
 * The picture's size on a roof of `roofWidth` by `roofDepth`: as large as it can be
 * inside the frame while keeping its own proportions, so nothing is stretched to fit.
 */
export function fitToRoof(imageWidth: number, imageHeight: number, roofWidth: number, roofDepth: number): { width: number; depth: number } {
  const maxWidth = roofWidth * ROOF_COVER;
  const maxDepth = roofDepth * ROOF_COVER;
  const aspect = imageWidth / Math.max(imageHeight, 1);
  if (maxWidth / maxDepth > aspect) return { width: maxDepth * aspect, depth: maxDepth };
  return { width: maxWidth, depth: maxWidth / aspect };
}

/**
 * Decodes straight to thumbnail size. Only a width is asked for first, which keeps the
 * image's proportions without knowing them up front; a portrait comes back taller than
 * the edge and is brought down by a second, cheap resize of the small bitmap.
 *
 * Flipped at decode, because WebGL does not flip an ImageBitmap on upload: the picture
 * lies on its roof with its top edge away from a camera that looks at it from the south.
 */
async function decodeThumbnail(blob: Blob): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = { imageOrientation: "flipY", premultiplyAlpha: "none", resizeQuality: "medium" };
  const wide = await createImageBitmap(blob, { ...options, resizeWidth: THUMBNAIL_EDGE });
  if (wide.height <= THUMBNAIL_EDGE) return wide;
  try {
    return await createImageBitmap(wide, { resizeHeight: THUMBNAIL_EDGE, resizeQuality: "medium" });
  } finally {
    wide.close();
  }
}

/** A unit square lying flat and facing up, scaled per picture to its footprint. */
function roofPlane(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
}

type Thumbnail = {
  placement: Placement;
  areaId: string;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  roofY: number;
  shownAt: number;
  fade: number;
};

type Job = { placement: Placement; areaId: string; group: THREE.Group };

export class ThumbnailLoader {
  /**
   * Compiled with every new district and never drawn, so the first picture to land does
   * not compile the thumbnail program mid-flight. Every thumbnail material is made with
   * the same parameters as this one, which is what lets a single program serve them all
   * while each keeps its own texture.
   */
  readonly primer: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly primerTexture: THREE.DataTexture;
  private readonly shown = new Map<Placement, Thumbnail>();
  /** Placements already tried, loaded or not, so a failure is not retried every visit. */
  private readonly attempted = new WeakSet<Placement>();
  private queue: Job[] = [];
  private running = 0;
  private batch = new AbortController();
  private disposed = false;

  constructor(private readonly read: ReadFile | undefined, private readonly anisotropy: number) {
    this.primerTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.primerTexture.needsUpdate = true;
    this.primer = new THREE.Mesh(roofPlane(), this.createMaterial(this.primerTexture));
    this.primer.position.y = -1000;
    this.primer.frustumCulled = false;
  }

  /**
   * Starts dressing a district's roofs, nearest to `from` first. Replaces whatever was
   * queued before: a request is made each time a district becomes the one being looked
   * at, and the one before it has stopped mattering.
   */
  request(areaId: string, group: THREE.Group, placements: readonly Placement[], from: THREE.Vector3): void {
    if (!this.read || this.disposed) return;
    this.cancel();
    this.queue = thumbnailCandidates(placements, from)
      .filter((placement) => !this.attempted.has(placement))
      .map((placement) => ({ placement, areaId, group }));
    this.pump();
  }

  /** Abandons every read and decode in flight or waiting. Pictures already shown stay. */
  cancel(): void {
    this.batch.abort();
    this.batch = new AbortController();
    this.queue = [];
  }

  /** Forgets the pictures of a district being torn down; its group frees their GPU side. */
  forgetArea(areaId: string): void {
    this.queue = this.queue.filter((job) => job.areaId !== areaId);
    for (const [placement, thumbnail] of this.shown) {
      if (thumbnail.areaId === areaId) this.shown.delete(placement);
    }
  }

  forgetAll(): void {
    this.cancel();
    this.shown.clear();
  }

  /** Keeps a picture on its roof while the tower under it lifts for the cursor. */
  lift(placement: Placement, lift: number): void {
    const thumbnail = this.shown.get(placement);
    if (thumbnail) thumbnail.mesh.position.y = thumbnail.roofY + lift;
  }

  /** Fades new pictures in and dims them with their district. */
  update(now: number, activationOf: (areaId: string) => number): void {
    this.shown.forEach((thumbnail) => {
      thumbnail.fade = Math.min((now - thumbnail.shownAt) / FADE_IN, 1);
      const dim = THREE.MathUtils.lerp(INACTIVE_OPACITY, 1, activationOf(thumbnail.areaId));
      thumbnail.mesh.material.opacity = THREE.MathUtils.smootherstep(thumbnail.fade, 0, 1) * dim;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.forgetAll();
    this.primer.material.dispose();
    this.primerTexture.dispose();
    this.primer.geometry.dispose();
  }

  private createMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
    // Not tone mapped: a photograph is already an image meant for a screen, and running it
    // through the scene's filmic curve would grade someone's pictures on their behalf. It
    // is shown a little under full brightness instead, which sits it among roofs the
    // curve has rolled off, and keeps its whites under the glow's threshold: a picture is
    // not a light, and a bright sky should not halo as if it were one.
    return new THREE.MeshBasicMaterial({ map, color: PICTURE_TINT, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  }

  private pump(): void {
    while (this.running < THUMBNAIL_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      if (!job) break;
      this.running += 1;
      void this.load(job, this.batch.signal).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async load(job: Job, signal: AbortSignal): Promise<void> {
    const { placement } = job;
    let bitmap: ImageBitmap | null = null;
    try {
      const blob = await this.read?.(placement.node, signal);
      if (!blob || signal.aborted) return;
      // Marked only once a read has come back: an aborted one is worth trying again later.
      this.attempted.add(placement);
      if (blob.size > THUMBNAIL_MAX_BYTES) return;
      bitmap = await decodeThumbnail(blob);
      if (signal.aborted || this.disposed || !job.group.parent) return;
      this.show(job, bitmap);
      bitmap = null;
    } catch {
      // A file that will not read or decode simply keeps a plain roof.
    } finally {
      bitmap?.close();
    }
  }

  private show(job: Job, bitmap: ImageBitmap): void {
    const { placement } = job;
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    // The bitmap is the texture's only copy on the CPU side; it goes when the texture does.
    texture.addEventListener("dispose", () => bitmap.close());
    const size = fitToRoof(bitmap.width, bitmap.height, placement.scale.x, placement.scale.z);
    // A plane of its own, four vertices, so the district's teardown can free it with the
    // rest of its group without reaching into anything shared.
    const mesh = new THREE.Mesh(roofPlane(), this.createMaterial(texture));
    const roofY = placement.position.y + placement.scale.y / 2 + ROOF_CLEARANCE;
    mesh.position.set(placement.position.x, roofY, placement.position.z);
    mesh.scale.set(size.width, 1, size.depth);
    mesh.name = "fsn-thumbnail";
    job.group.add(mesh);
    this.shown.set(placement, { placement, areaId: job.areaId, mesh, roofY, shownAt: performance.now(), fade: 0 });
  }
}
