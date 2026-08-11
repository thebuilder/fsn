/**
 * Regenerates public/demo-models/resonator-coil.stl.
 *
 * The demo filesystem has no File objects behind it, so anything the model viewer
 * should open in demo mode needs real bytes served from public/. Run with:
 *
 *   node tools/make-demo-model.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const OUTPUT = fileURLToPath(new URL("../public/demo-models/resonator-coil.stl", import.meta.url));

/** Serialises a non-indexed BufferGeometry as binary STL (84-byte header + 50 bytes per facet). */
function toBinaryStl(geometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const facets = position.count / 3;
  const buffer = new DataView(new ArrayBuffer(84 + facets * 50));
  buffer.setUint32(80, facets, true);

  for (let facet = 0; facet < facets; facet += 1) {
    let offset = 84 + facet * 50;
    const base = facet * 3;
    // One normal per facet: STL has no per-vertex normals, so average the three.
    for (let axis = 0; axis < 3; axis += 1) {
      const sum = normal.array[base * 3 + axis] + normal.array[(base + 1) * 3 + axis] + normal.array[(base + 2) * 3 + axis];
      buffer.setFloat32(offset + axis * 4, sum / 3, true);
    }
    offset += 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        buffer.setFloat32(offset, position.array[(base + vertex) * 3 + axis], true);
        offset += 4;
      }
    }
  }
  return Buffer.from(buffer.buffer);
}

const geometry = new THREE.TorusKnotGeometry(10, 3.2, 128, 20, 2, 3).toNonIndexed();
geometry.computeVertexNormals();
const stl = toBinaryStl(geometry);

await mkdir(fileURLToPath(new URL("../public/demo-models", import.meta.url)), { recursive: true });
await writeFile(OUTPUT, stl);
console.log(`wrote ${OUTPUT} (${stl.length} bytes, ${(stl.length - 84) / 50} facets)`);
