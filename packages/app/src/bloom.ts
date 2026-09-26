import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { CopyShader } from "three/addons/shaders/CopyShader.js";

/**
 * The phosphor glow: an optional bloom over the parts of the frame that are meant to be
 * lit from within — the scan's front, the selection outline, the pulse on a wire — so
 * they halo the way a vector display's trace does, while the city itself stays crisp.
 *
 * The frame is rendered into the composer exactly as it would be drawn to the canvas:
 * tone mapped and encoded for display, not left linear for an output pass to finish.
 * That is what keeps the look with the glow off and the look under it the same picture.
 * Three only finishes a frame for display when it is drawing to the screen or to an XR
 * target, and marking the composer's targets as the latter makes every material compile
 * exactly the program it already uses on screen. So turning the glow on adds the bloom's
 * own few programs and recompiles nothing else, and the custom shaders that write their
 * colour raw (the floor grid, the scan cage) keep the colour they were tuned to.
 *
 * It follows that the threshold is measured against display brightness, 0 to 1. The
 * filmic curve rolls every lit face off before white — the palest roofs peak around
 * 0.85 — so the threshold sits just above them. What clears it is what carries light
 * past the curve: the scan's emissive front, its raw wire cage, a wire's pulse, and the
 * outlines, which the scene burns hotter while the glow is up (see `OUTLINE_GLOW_HEAT`).
 * The beacons under each district are a soft glow already and are left below it.
 */

const STRENGTH = 2.2;
const RADIUS = 0.4;
const THRESHOLD = 0.86;
/** A soft knee, so a face that brightens into the threshold eases into its glow. */
const KNEE = 0.06;
/** How quickly the glow comes up or dies away when switched, in seconds to settle. */
const FADE = 0.35;

/** Buffer pixels past which the glow is not offered by default: every pass scales with them. */
const DEFAULT_PIXEL_BUDGET = 4_500_000;
export const GLOW_STORAGE_KEY = "fsn:glow";

export type GlowEnvironment = {
  coarsePointer: boolean;
  width: number;
  height: number;
  pixelRatio: number;
};

/**
 * Whether the glow starts on for a viewer who has never chosen. It costs a handful of
 * full-screen passes a frame, which a desktop GPU does not notice and a phone does; and a
 * screen dense enough that its buffer is already huge pays for every pass per pixel.
 */
export function glowByDefault(environment: GlowEnvironment): boolean {
  if (environment.coarsePointer) return false;
  const pixels = environment.width * environment.height * environment.pixelRatio ** 2;
  return pixels <= DEFAULT_PIXEL_BUDGET;
}

/** The viewer's own choice, if they have made one and it can be read back. */
export function readGlowPreference(storage: Pick<Storage, "getItem"> | null): boolean | null {
  try {
    const value = storage?.getItem(GLOW_STORAGE_KEY);
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
}

export function writeGlowPreference(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(GLOW_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // A private window or blocked storage: the choice lasts for this visit only.
  }
}

function viewerStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Wires the glow switch in the control strip: starts from the viewer's remembered choice
 * or, failing that, from what this device can comfortably afford, and remembers each
 * change for next time. The choice is per viewer and per browser, which is all a look
 * preference needs to be.
 */
export function mountGlowToggle(button: HTMLButtonElement, target: { setGlow(on: boolean): void }, signal: AbortSignal): void {
  const storage = viewerStorage();
  let on = readGlowPreference(storage) ?? glowByDefault({
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    width: window.innerWidth,
    height: window.innerHeight,
    // The renderer caps its ratio at 2, so a 3x screen pays for 2x.
    pixelRatio: Math.min(window.devicePixelRatio, 2),
  });
  const apply = () => {
    button.setAttribute("aria-pressed", String(on));
    target.setGlow(on);
  };
  apply();
  button.addEventListener("click", () => {
    on = !on;
    writeGlowPreference(storage, on);
    apply();
  }, { signal });
}

/**
 * The bloom's bright-pass, taking the brightest of each 2×2 block rather than their
 * average. It works at half resolution, and the stock pass samples between four pixels:
 * a line one pixel wide — every outline and wire in this world — arrives at half its
 * brightness and never crosses the threshold, however hot it is drawn.
 */
const BRIGHT_PASS_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 defaultColor;
  uniform float defaultOpacity;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  varying vec2 vUv;

  void main() {
    vec2 texel = 0.5 / vec2(textureSize(tDiffuse, 0));
    vec4 brightest = texture2D(tDiffuse, vUv + vec2(-texel.x, -texel.y));
    vec4 candidate = texture2D(tDiffuse, vUv + vec2(texel.x, -texel.y));
    if (luminance(candidate.rgb) > luminance(brightest.rgb)) brightest = candidate;
    candidate = texture2D(tDiffuse, vUv + vec2(-texel.x, texel.y));
    if (luminance(candidate.rgb) > luminance(brightest.rgb)) brightest = candidate;
    candidate = texture2D(tDiffuse, vUv + vec2(texel.x, texel.y));
    if (luminance(candidate.rgb) > luminance(brightest.rgb)) brightest = candidate;
    float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, luminance(brightest.rgb));
    gl_FragColor = mix(vec4(defaultColor, defaultOpacity), brightest, alpha);
  }
`;

/** See the module comment: this is what makes the composer's frame the screen's frame. */
function finishForDisplay(target: THREE.WebGLRenderTarget): void {
  Object.assign(target, { isXRRenderTarget: true });
}

type Chain = {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  output: ShaderPass;
};

export class PhosphorBloom {
  private chain: Chain | null = null;
  private width = 1;
  private height = 1;
  private preparing: Promise<void> | null = null;
  private ready = false;
  private strength = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {}

  /** True while the frame should go through the composer rather than straight out. */
  get drawing(): boolean {
    return this.ready && this.strength > 0.001;
  }

  /** How far the glow is faded in, 0 to 1, for the things that run hotter under it. */
  get level(): number {
    return this.ready ? this.strength / STRENGTH : 0;
  }

  get isPreparing(): boolean {
    return this.preparing !== null;
  }

  get isReady(): boolean {
    return this.ready;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.chain?.composer.setSize(this.width, this.height);
  }

  /**
   * Builds the passes and compiles their programs off the frame where the driver can, so
   * the first glowing frame does not also pay for linking them. Called only once the
   * view is still: this is compilation, and it must not land in a reveal or a flight.
   */
  prepare(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.preparing ??= this.compile().then(
      () => {
        this.ready = true;
        this.preparing = null;
      },
      () => {
        // Nothing was lost: the passes compile on their first frame instead.
        this.ready = true;
        this.preparing = null;
      },
    );
    return this.preparing;
  }

  /**
   * Eases the glow towards on or off. Off is a fade to nothing and then a return to
   * drawing straight to the canvas; the passes' render targets are freed at that point,
   * which is most of what the glow holds on a phone, and come back on the next frame
   * that needs them. The programs stay, so switching it back on is immediate.
   */
  update(delta: number, wanted: boolean): void {
    if (!this.chain) return;
    const target = wanted && this.ready ? STRENGTH : 0;
    const step = 1 - Math.exp(-delta * (4 / FADE));
    const wasDrawing = this.drawing;
    this.strength += (target - this.strength) * step;
    if (Math.abs(target - this.strength) < 0.002) this.strength = target;
    this.chain.bloom.strength = this.strength;
    if (wasDrawing && !this.drawing) this.releaseTargets();
  }

  render(delta: number): void {
    this.chain?.composer.render(delta);
  }

  dispose(): void {
    if (!this.chain) return;
    const { composer, bloom, output } = this.chain;
    bloom.dispose();
    output.dispose();
    composer.dispose();
    this.chain = null;
  }

  private build(): Chain {
    const pixelRatio = this.renderer.getPixelRatio();
    // Eight bits is all the canvas has, and the frame arrives already encoded for it.
    // Multisampled, because the canvas it stands in for is antialiased.
    const target = new THREE.WebGLRenderTarget(this.width * pixelRatio, this.height * pixelRatio, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      internalFormat: "RGBA8",
      samples: this.renderer.capabilities.maxSamples > 0 ? 4 : 0,
    });
    const composer = new EffectComposer(this.renderer, target);
    finishForDisplay(composer.renderTarget1);
    finishForDisplay(composer.renderTarget2);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(this.width, this.height);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0, RADIUS, THRESHOLD);
    bloom.materialHighPassFilter.fragmentShader = BRIGHT_PASS_FRAGMENT;
    bloom.materialHighPassFilter.uniforms.smoothWidth.value = KNEE;
    composer.addPass(bloom);
    // A plain copy to the canvas, not an OutputPass: the frame is already tone mapped and
    // encoded, and finishing it a second time would wash every colour out.
    const output = new ShaderPass(CopyShader);
    composer.addPass(output);
    return { composer, bloom, output };
  }

  /**
   * Compiles each pass for the target it will draw into, because the target is part of
   * what picks a program: the bright-pass, blurs and composite work in the bloom's own
   * linear buffers, while the final blend and copy write display-ready colour.
   */
  private async compile(): Promise<void> {
    this.chain ??= this.build();
    const { composer, bloom, output } = this.chain;
    const quad = new THREE.PlaneGeometry(2, 2);
    const internal = new THREE.Scene();
    for (const material of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial]) {
      internal.add(new THREE.Mesh(quad, material));
    }
    const display = new THREE.Scene();
    display.add(new THREE.Mesh(quad, bloom.blendMaterial), new THREE.Mesh(quad, output.material));
    const camera = new THREE.OrthographicCamera();
    const previous = this.renderer.getRenderTarget();
    let pending: Promise<unknown>[];
    try {
      // `compileAsync` reads the target when called and only waits afterwards, so the
      // target can be put back straight away rather than held across the wait.
      this.renderer.setRenderTarget(bloom.renderTargetBright);
      const inner = this.renderer.compileAsync(internal, camera);
      this.renderer.setRenderTarget(composer.renderTarget1);
      const outer = this.renderer.compileAsync(display, camera);
      pending = [inner, outer];
    } finally {
      this.renderer.setRenderTarget(previous);
    }
    try {
      await Promise.all(pending);
    } finally {
      quad.dispose();
    }
  }

  private releaseTargets(): void {
    if (!this.chain) return;
    const { composer, bloom } = this.chain;
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    bloom.renderTargetBright.dispose();
    bloom.renderTargetsHorizontal.forEach((target) => target.dispose());
    bloom.renderTargetsVertical.forEach((target) => target.dispose());
  }
}
