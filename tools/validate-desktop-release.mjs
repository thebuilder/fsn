import { readFile } from "node:fs/promises";

const tag = process.argv[2];
if (!tag) {
  throw new Error("Pass the release tag, for example: pnpm validate:desktop-release v0.1.0");
}

const desktopPackage = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const cargoManifest = await readFile("apps/desktop/src-tauri/Cargo.toml", "utf8");
const tauriConfig = JSON.parse(await readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const expectedTag = `v${desktopPackage.version}`;

if (!cargoVersion) {
  throw new Error("Could not read the desktop version from Cargo.toml");
}

const mismatches = [];
if (tag !== expectedTag) mismatches.push(`tag is ${tag}; expected ${expectedTag}`);
if (cargoVersion !== desktopPackage.version) {
  mismatches.push(`Cargo.toml is ${cargoVersion}; desktop package is ${desktopPackage.version}`);
}
if (tauriConfig.version !== "../package.json") {
  mismatches.push("tauri.conf.json must read its version from ../package.json");
}

if (mismatches.length) {
  throw new Error(`Desktop release versions do not match:\n- ${mismatches.join("\n- ")}`);
}

console.log(`Desktop release ${tag} matches version ${desktopPackage.version}.`);
