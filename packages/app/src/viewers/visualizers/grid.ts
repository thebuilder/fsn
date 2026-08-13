import * as THREE from "three";
import { bandLevel, logBands } from "./bands";
import type { CreateVisualizer, Signal, Visualizer } from "./types";
import { createWaveField } from "./wavefield";

/** Terrain resolution. Columns run across the road, rows run into the distance. */
const COLS = 56;
const ROWS = 90;
const WIDTH = 90;
const DEPTH = 180;
/** Where the near edge sits, in front of the camera at z = 20, so no edge is visible. */
const NEAR_Z = 30;
const ROW_SPACING = DEPTH / (ROWS - 1);
/** Base travel speed in world units per second. */
const SPEED = 26;
const AMPLITUDE = 6.5;
/** Height the terrain asymptotes toward, kept clear of the camera at y = 7.2. */
const CEILING = 6;

/** Highest bin the road reads, matching the bars so the two agree about the music. */
const TOP_BIN = 220;

/**
 * The beat line: the row where an onset strikes the road, a short way ahead of the
 * camera. Close enough that the hit lands in the viewer's lap, far enough that the
 * wave rolling away toward the horizon can be watched going.
 */
const BEAT_ROW = Math.round(0.24 * (ROWS - 1));
const BEAT_LINE_V = BEAT_ROW / (ROWS - 1);
/** Wave field: fixed simulation step, squared Courant number, per-step retention. */
const WAVE_STEP = 1 / 120;
const WAVE_COURANT2 = 0.22;
const WAVE_DAMP = 0.994;
const WAVE_HEIGHT = 3.4;
/** Bytes hold wave displacement as value * WAVE_PACK + 0.5, so troughs fit too. */
const WAVE_PACK = 0.4;
/** Terrain envelope: attack is instant, and each scrolled row keeps this much of a peak. */
const ROW_DECAY = 0.84;

const CYAN = new THREE.Color(0x4ff0ff);
const MAGENTA = new THREE.Color(0xff4fd8);
const SKY_LOW = new THREE.Color(0x4a1873);
const SKY_HIGH = new THREE.Color(0x05060f);
const HORIZON = new THREE.Color(0xff5bb0);

/**
 * The synthwave landscape.
 *
 * The grid is real geometry — line segments between neighbouring vertices of a
 * displaced lattice — rather than a `fract()` pattern painted onto a plane. Those two
 * only agree if the painted cell size happens to match the vertex spacing; when they
 * do not, the lines float free of the surface they are supposed to describe and every
 * ridge tears along a seam.
 *
 * Two things drive the height. The spectrum is written one row at a time at the
 * horizon and scrolls toward the camera — through a fast-attack, slow-release
 * envelope per column, so a hit rises as a sharp ridge and falls away over the rows
 * behind it instead of writing a plateau. And each onset strikes the beat line, a
 * fixed row just ahead of the camera, driving a damped wave field simulated over the
 * whole lattice: the hit ripples out toward the horizon and past the camera, which
 * is what actually reads as being on the beat. The scrolling terrain alone cannot do
 * that: at this length and speed a ridge needs some seven seconds to arrive, so the
 * ground under you would be answering a bar you have long forgotten.
 */
export const createGridVisualizer: CreateVisualizer = (stage, width, height): Visualizer => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.setClearColor(SKY_HIGH, 1);
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, width / Math.max(height, 1), 0.1, 500);

  // Height buffer: one byte per lattice point, last row newest (at the horizon).
  const heights = new Uint8Array(COLS * ROWS);
  const historyTexture = new THREE.DataTexture(heights, COLS, ROWS, THREE.RedFormat, THREE.UnsignedByteType);
  historyTexture.minFilter = THREE.LinearFilter;
  historyTexture.magFilter = THREE.LinearFilter;
  historyTexture.needsUpdate = true;

  // Wave displacement, encoded around a 128 centre so both crests and troughs fit
  // in a byte — floats would need an extension for linear filtering.
  const waveBytes = new Uint8Array(COLS * ROWS).fill(128);
  const waveTexture = new THREE.DataTexture(waveBytes, COLS, ROWS, THREE.RedFormat, THREE.UnsignedByteType);
  waveTexture.minFilter = THREE.LinearFilter;
  waveTexture.magFilter = THREE.LinearFilter;
  waveTexture.needsUpdate = true;

  const uniforms = {
    uHistory: { value: historyTexture },
    uWave: { value: waveTexture },
    uAmplitude: { value: AMPLITUDE },
    uBeat: { value: 0 },
    uPump: { value: 0 },
    uEmerge: { value: 0 },
    uScroll: { value: 0 },
    uCool: { value: CYAN },
    uHot: { value: MAGENTA },
  };

  const terrain = new THREE.LineSegments(
    createLattice(),
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
    }),
  );
  terrain.renderOrder = 2;
  scene.add(terrain);

  // An opaque floor under the wireframe, so the sky does not glow through the gaps.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WIDTH * 3, DEPTH + 80),
    new THREE.MeshBasicMaterial({ color: 0x06070e }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.6, NEAR_Z - DEPTH / 2);
  ground.renderOrder = 1;
  scene.add(ground);

  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(700, 340),
    new THREE.ShaderMaterial({
      uniforms: { uLow: { value: SKY_LOW }, uHigh: { value: SKY_HIGH }, uHorizon: { value: HORIZON } },
      depthWrite: false,
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `
        uniform vec3 uLow; uniform vec3 uHigh; uniform vec3 uHorizon; varying vec2 vUv;
        void main() {
          vec3 sky = mix(uLow, uHigh, pow(clamp(vUv.y, 0.0, 1.0), 0.62));
          float glow = smoothstep(0.17, 0.0, abs(vUv.y - 0.155)) * 0.3;
          gl_FragColor = vec4(sky + uHorizon * glow, 1.0);
        }
      `,
    }),
  );
  sky.position.set(0, 70, NEAR_Z - DEPTH - 60);
  sky.renderOrder = -2;
  scene.add(sky);

  const stars = createStars();
  scene.add(stars);

  const sunUniforms = { uBeat: { value: 0 }, uTime: { value: 0 } };
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.ShaderMaterial({
      uniforms: sunUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: SUN_FRAGMENT,
    }),
  );
  sun.position.set(0, 13, NEAR_Z - DEPTH - 30);
  sun.renderOrder = -1;
  scene.add(sun);

  let travel = 0;
  let shake = 0;
  let speed = 0;
  let pump = 0;
  let emerge = 0;
  let simPending = 0;
  let prevBeat = 0;
  let prevBass = 0;
  const waves = createWaveField(COLS, ROWS, WAVE_COURANT2, WAVE_DAMP);
  const strikeWeights = new Float32Array(COLS);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const speedScale = reduced ? 0.35 : 1;
  const strikeScale = reduced ? 0.45 : 1;

  /**
   * True until the buffer holds real audio. A freshly zeroed buffer would otherwise
   * meet the first incoming row as a vertical wall — the cliff you see at the start
   * of a track and immediately after a scrub — so the first row is copied over the
   * whole road instead of scrolling in against silence.
   */
  let refill = true;

  /**
   * Half a road's worth of equal-octave bands, mirrored about the centre line. Bass
   * sits in the middle and treble runs out to the shoulders, but each column now owns
   * a genuine slice of the spectrum — where a power curve into bin index gave the
   * bottom two octaves a quarter of the width, which went solid on every kick.
   */
  const bands = logBands(Math.ceil(COLS / 2), TOP_BIN);
  /** Slow follower per band, so each column can be measured against its own normal. */
  const settled = new Float32Array(bands.length);
  /** Fast-attack, slow-release envelope per band; what actually gets written to rows. */
  const envelope = new Float32Array(bands.length);

  /** Band index for a column: bass on the centre line, treble out at the shoulders. */
  const columnBand = (column: number): number => {
    const across = Math.abs((column / (COLS - 1)) * 2 - 1);
    return Math.min(bands.length - 1, Math.round(across * (bands.length - 1)));
  };

  /** Writes one analysis frame into the far row; everything else shifts one step nearer. */
  const pushRow = (signal: Signal): void => {
    heights.copyWithin(0, COLS);
    const base = (ROWS - 1) * COLS;
    for (let column = 0; column < COLS; column += 1) {
      const across = Math.abs((column / (COLS - 1)) * 2 - 1);
      const index = columnBand(column);
      const level = bandLevel(signal.frequency, bands[index]);
      if (column <= COLS / 2) {
        settled[index] += (level - settled[index]) * 0.05;

        // Two terms: the band's own level, expanded because a busy mix only ever
        // uses the top of the range, plus how far it sits above its recent normal so
        // an attack stands proud of the passage it lands in. The result runs through
        // an envelope — attack lands whole, release keeps only ROW_DECAY per row —
        // so a hit writes a ridge with a sharp face and a falling tail, where the
        // raw levels of a sustained passage wrote one long plateau.
        const transient = Math.max(0, level - settled[index]);
        const excitation = (level ** 2.2 * 0.4 + transient * 1.7) * (1 + signal.beat * 0.55);
        envelope[index] = excitation > envelope[index] ? excitation : envelope[index] * ROW_DECAY;
      }

      const shoulder = 1 - across * 0.3;
      // A drifting swell keeps the landscape alive before anything is playing.
      const idle = 0.05 + Math.sin(travel * 0.08 + column * 0.3) * 0.028 + Math.cos(travel * 0.05 - column * 0.13) * 0.02;
      const raw = envelope[index] * shoulder + idle;
      // Soft knee, never a hard clamp. Clipping here is what flatlines the middle of
      // the road: the centre columns run hottest, so they are the first to hit the
      // ceiling and sit there, pinned flat and fully magenta, for the whole passage.
      heights[base + column] = Math.round((1 - Math.exp(-1.35 * raw)) * 255);
    }
    if (refill) {
      for (let row = 0; row < ROWS - 1; row += 1) heights.copyWithin(row * COLS, base, base + COLS);
      // Stay armed until there is actually something to seed from. The first row is
      // pushed the moment the viewer opens, long before audio flows, and seeding the
      // whole road from silence leaves it flat until every row has scrolled through.
      if (signal.playing && signal.level > 0.02) refill = false;
    }
    historyTexture.needsUpdate = true;
  };

  const frame = (signal: Signal): void => {
    const delta = signal.delta;
    // Paused means stopped. A road that keeps rolling while the transport says paused
    // reads as broken, and it fills the buffer with rows of silence besides.
    const target = signal.playing ? SPEED * speedScale * (1 + signal.level * 0.5) : 0;
    speed += (target - speed) * Math.min(1, delta * 2.5);
    travel += speed * delta;

    // Fast attack, slow release. This is the term that is genuinely in time with the
    // music: the scrolling history can only ever show you the past, so the landscape
    // breathes on the current bass instead of waiting for a ridge to arrive.
    pump += (signal.bass - pump) * Math.min(1, delta * (signal.bass > pump ? 26 : 6));

    // At most two rows a frame: a speed ramp used to shove a burst of them through
    // at once, which is the lurch you get on pressing play.
    let pushes = 0;
    while (travel >= ROW_SPACING && pushes < 2) {
      travel -= ROW_SPACING;
      pushes += 1;
      pushRow(signal);
    }
    if (pushes === 2) travel = 0;
    // The lattice slides forward by less than one row, then wraps as the data shifts —
    // which is what makes a finite strip of geometry read as an endless road.
    terrain.position.z = travel;

    // An onset strikes the beat line, shaped by the spectrum so the hit is tallest
    // where the music is loudest; between onsets a rising bass gives it a smaller
    // nudge, so the surface keeps swelling with the groove even when the detector
    // stays quiet. The field does the rest: ripples run off toward the horizon and
    // past the camera, ring off the shoulders, and die away.
    const bassRise = Math.max(0, signal.bass - prevBass);
    const struck = signal.beat > prevBeat;
    if (signal.playing && (struck || bassRise > 0.012)) {
      for (let column = 0; column < COLS; column += 1) {
        strikeWeights[column] = 0.45 + bandLevel(signal.frequency, bands[columnBand(column)]) * 0.9;
      }
      const strength = struck ? 0.55 + signal.level * 0.9 : Math.min(0.5, bassRise * 2.4);
      waves.strike(BEAT_ROW, strikeWeights, strength * strikeScale);
    }
    prevBeat = signal.beat;
    prevBass = signal.bass;

    // Fixed-step so the wave speed does not depend on the frame rate; capped so a
    // slow frame cannot queue a burst of catch-up steps.
    simPending = Math.min(simPending + delta, WAVE_STEP * 5);
    while (simPending >= WAVE_STEP) {
      simPending -= WAVE_STEP;
      waves.step();
    }
    const field = waves.read();
    for (let index = 0; index < field.length; index += 1) {
      waveBytes[index] = Math.max(0, Math.min(255, Math.round((field[index] * WAVE_PACK + 0.5) * 255)));
    }
    waveTexture.needsUpdate = true;

    // The seed lands on every row at once, so without this the road would snap from
    // a bare plane to a fully formed landscape in a single frame. Rising out of the
    // plane instead reads as the world arriving with the music.
    emerge += ((refill ? 0 : 1) - emerge) * Math.min(1, delta * 1.6);

    uniforms.uBeat.value = signal.beat;
    uniforms.uPump.value = pump;
    uniforms.uEmerge.value = emerge;
    // The wave field lives in world space; the shader shifts its samples back by the
    // lattice's slide so crests stand still while the road moves beneath them.
    uniforms.uScroll.value = travel / DEPTH;
    uniforms.uAmplitude.value = AMPLITUDE * (reduced ? 0.55 : 1);
    sunUniforms.uBeat.value = signal.beat;
    sunUniforms.uTime.value = signal.elapsed;
    (stars.material as THREE.PointsMaterial).opacity = 0.55 + signal.treble * 0.45;

    shake = Math.max(shake * (1 - delta * 5), reduced ? 0 : signal.beat * 0.45);
    // Low enough that ridges have visible relief against the horizon. Looking down
    // from higher up flattens the whole landscape into a map of itself.
    camera.position.set(Math.sin(signal.elapsed * 0.6) * 0.3, 7.2 + shake, 20);
    camera.lookAt(0, -6 + shake * 0.8, -60);
    renderer.render(scene, camera);
  };

  return {
    frame,
    reset: () => {
      // Not a zero fill: the next frame reseeds every row, so the road never shows
      // a step between the new position's audio and the old position's trail.
      refill = true;
      envelope.fill(0);
      waves.clear();
    },
    resize: (nextWidth, nextHeight) => {
      renderer.setSize(nextWidth, nextHeight, false);
      camera.aspect = nextWidth / Math.max(nextHeight, 1);
      camera.updateProjectionMatrix();
    },
    dispose: () => {
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          const material = child.material;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material.dispose();
        }
      });
      historyTexture.dispose();
      waveTexture.dispose();
      renderer.dispose();
      // The world behind the dialog holds a context too; hand this one back.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
};

/**
 * A lattice of vertices wired up as line segments: across for the rows, lengthways
 * for the columns. Neighbours share vertices, so the surface stays welded together
 * however far the shader displaces it.
 */
function createLattice(): THREE.BufferGeometry {
  const count = COLS * ROWS;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      const index = row * COLS + column;
      positions[index * 3] = (column / (COLS - 1) - 0.5) * WIDTH;
      positions[index * 3 + 1] = 0;
      positions[index * 3 + 2] = NEAR_Z - (row / (ROWS - 1)) * DEPTH;
      uvs[index * 2] = column / (COLS - 1);
      uvs[index * 2 + 1] = row / (ROWS - 1);
    }
  }

  const indices: number[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS - 1; column += 1) {
      const index = row * COLS + column;
      indices.push(index, index + 1);
    }
  }
  for (let row = 0; row < ROWS - 1; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      const index = row * COLS + column;
      indices.push(index, index + COLS);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function createStars(): THREE.Points {
  const count = 900;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const radius = 170 + Math.random() * 130;
    const angle = Math.PI * (0.05 + Math.random() * 0.9);
    const lift = Math.random() ** 1.6;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = 8 + lift * 140;
    positions[index * 3 + 2] = -Math.sin(angle) * radius - 40;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0xdfe8ff, size: 0.8, sizeAttenuation: true, transparent: true, opacity: 0.75, depthWrite: false }),
  );
}

const TERRAIN_VERTEX = /* glsl */ `
  uniform sampler2D uHistory;
  uniform sampler2D uWave;
  uniform float uAmplitude;
  uniform float uPump;
  uniform float uEmerge;
  uniform float uScroll;
  varying float vHeight;
  varying float vFade;
  varying float vRow;

  void main() {
    // uv.y == 1 is the horizon, and the newest row of the buffer.
    float terrain = texture2D(uHistory, uv).r;

    // The wave field is fixed in world space: sampling at a scroll-corrected row
    // keeps crests still while the lattice slides forward and wraps beneath them.
    vRow = uv.y - uScroll;
    float wave = (texture2D(uWave, vec2(uv.x, vRow)).r - 0.5) / ${WAVE_PACK.toFixed(2)};

    // Settle the far edge into the haze so the wrap seam never shows.
    float ends = smoothstep(1.0, 0.9, uv.y);
    // Emerge folded in here so the colour rises with the ground, rather than sitting
    // hot over a plane that has not grown yet.
    vHeight = terrain * ends * uEmerge;

    vec3 displaced = position;
    // The whole landscape swells on the current bass, hardest close to the camera
    // where there is room to see it, so the ground answers the kick as you hear it.
    float near = 0.55 + smoothstep(1.0, 0.1, uv.y) * 0.85;
    // The pump adds to full relief rather than scaling up from a flattened base, so a
    // quiet passage still has a landscape instead of a plain.
    float raised = vHeight * uAmplitude * (1.0 + uPump * near * 1.1) + wave * ${WAVE_HEIGHT.toFixed(2)} * ends * uEmerge;
    // Soft ceiling well below the camera, soft floor just above the ground plane.
    // Peaks must not run through the lens on a loud passage, and a wave trough must
    // not dip under the opaque floor, which would cut the grid into dark gaps —
    // and a hard clamp at either end would shear the shape off flat.
    displaced.y += raised > 0.0
      ? ${CEILING.toFixed(1)} * (1.0 - exp(-raised / ${CEILING.toFixed(1)}))
      : -0.55 * (1.0 - exp(raised / 0.55));

    // Wave crests earn heat the way terrain peaks do; troughs stay cool.
    vHeight += max(wave, 0.0) * 0.4;

    vFade = smoothstep(1.0, 0.35, uv.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const TERRAIN_FRAGMENT = /* glsl */ `
  uniform vec3 uCool;
  uniform vec3 uHot;
  uniform float uBeat;
  varying float vHeight;
  varying float vFade;
  varying float vRow;

  void main() {
    // Ordinary ground stays cyan; only genuine peaks earn the hot end of the ramp.
    vec3 color = mix(uCool, uHot, clamp(vHeight * vHeight * 2.2 + uBeat * 0.15, 0.0, 1.0));
    // The beat line: a faint standing marker where onsets strike, flaring with each
    // hit so the eye learns where the beat lands before the wave sets out.
    float line = exp(-pow((vRow - ${BEAT_LINE_V.toFixed(4)}) * 60.0, 2.0));
    color += uHot * line * (0.12 + uBeat * 0.9);
    float glow = vFade * (0.85 + uBeat * 0.45) + line * (0.05 + uBeat * 0.35);
    gl_FragColor = vec4(color * glow, glow);
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  uniform float uBeat;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    vec2 centred = vUv * 2.0 - 1.0;
    float radius = length(centred);
    float disc = smoothstep(0.52, 0.5, radius);

    // Slits widen toward the bottom of the disc, the way every one of these suns does.
    float band = smoothstep(0.0, 1.0, fract(centred.y * 9.0 - uTime * 0.35));
    float slit = smoothstep(-0.55, 0.35, centred.y) * step(band, 0.52);
    disc *= 1.0 - slit;

    vec3 top = vec3(1.0, 0.85, 0.32);
    vec3 bottom = vec3(1.0, 0.22, 0.62);
    vec3 color = mix(bottom, top, clamp(vUv.y * 1.15, 0.0, 1.0));

    float halo = smoothstep(0.95, 0.32, radius) * 0.45;
    float pulse = 1.0 + uBeat * 0.4;
    gl_FragColor = vec4(color * (disc + halo) * pulse, (disc + halo * 0.75) * pulse);
  }
`;
