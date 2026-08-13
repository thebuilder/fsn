# Releasing the desktop app

This is the maintainer runbook for cutting a desktop release: what the pipeline
does today, how to turn on macOS signing and notarization when certificates
exist, what the experimental Windows/Linux jobs produce, and the full secrets
inventory. It documents fields and env var names; it does not provision or
store any secret value.

## 1. Today's flow

The tag-triggered release flow (validate → check → build → draft prerelease)
is described in the [README's release section](../README.md#verification).
In short: `pnpm validate:desktop-release vX.Y.Z`, tag, push the tag, and
`.github/workflows/release-desktop.yml` builds an unsigned, un-notarized
Apple Silicon `.app`/`.dmg` and attaches it to a draft GitHub prerelease. The
release body currently warns that the build is unsigned.

## 2. macOS signing & notarization

### Prerequisites (one-time, per Apple Developer account)

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) (paid, annual).
2. In Xcode or the Apple Developer portal, create a **Developer ID
   Application** certificate — this is the identity used to sign apps
   distributed outside the Mac App Store.
3. Export the certificate + private key as a `.p12` file, protected by a
   password. This file is what becomes the `APPLE_CERTIFICATE` secret
   (base64-encoded), not committed anywhere.
4. Decide on a notarization credential method (pick one):
   - **Apple ID method**: an app-specific password for your Apple ID, plus
     your Team ID.
   - **App Store Connect API key method**: an API key generated in App Store
     Connect (Issuer ID, Key ID, and the downloaded `.p8` key file).

### Config change (one-time)

Set the signing identity in `apps/desktop/src-tauri/tauri.conf.json` under
`bundle.macOS.signingIdentity` — the certificate's common name (e.g.
`Developer ID Application: Your Name (TEAMID)`).
<!-- Verified: https://v2.tauri.app/distribute/sign/macos/ — "tauri.conf.json > bundle > macOS > signingIdentity" -->

This repository does not set this field today; the maintainer flips it once
the certificate secrets below exist.

### Secrets to add (one-time, names only)

Add these as GitHub Actions repository (or environment) secrets. See the
[secrets inventory](#4-secrets-inventory) for the full table; the
notarization-credential secrets are two alternative sets — only one set is
needed:

- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` — the `.p12` (base64) and
  its password, consumed by the Tauri CLI during build to import the signing
  certificate into a temporary keychain.
  <!-- Verified: https://v2.tauri.app/distribute/sign/macos/ -->
- `KEYCHAIN_PASSWORD` — password for the temporary keychain the CI runner
  creates to hold the imported certificate.
  <!-- Verified: https://v2.tauri.app/distribute/sign/macos/ -->
- Notarization, Apple ID method: `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
  <!-- Verified: https://v2.tauri.app/distribute/sign/macos/ -->
- Notarization, API key method (alternative to the above):
  `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`.
  <!-- Verified: https://v2.tauri.app/distribute/sign/macos/ -->

### How tauri-action consumes this (per-release, automatic)

`tauri-apps/tauri-action` (used in `release-macos`) invokes the Tauri CLI's
bundler, which reads `bundle.macOS.signingIdentity` from `tauri.conf.json`
and the `APPLE_*`/`KEYCHAIN_PASSWORD` environment variables directly — these
are consumed by the Tauri CLI/bundler itself during `tauri build`, not by
tauri-action's own code, so they must be exported as `env:` on the
"Build and create draft release" step (the same step that already sets
`GITHUB_TOKEN`) rather than as `with:` inputs.
<!-- Verified against https://v2.tauri.app/distribute/sign/macos/ ;
     the tauri-action README (https://github.com/tauri-apps/tauri-action)
     does not itself document Apple-specific env vars — it passes the
     environment through to `tauri build`. -->

Once secrets exist and `signingIdentity` is set, every tagged release is
signed and notarized automatically — no per-release manual step beyond
pushing the tag.

### Verifying a signed artifact (per-release, manual spot check)

After a signed release is built, a maintainer should download the `.app` or
`.dmg` once and confirm all three:

```sh
codesign --verify --deep --strict /path/to/FSN.app
spctl -a -vv /path/to/FSN.app
xcrun stapler validate /path/to/FSN.app
```

`codesign` confirms the signature is intact, `spctl` simulates Gatekeeper's
assessment, and `stapler validate` confirms the notarization ticket is
stapled to the app (so it opens offline without a network check).

## 3. Windows & Linux

Two **experimental** jobs (`release-windows-experimental`,
`release-linux-experimental`) build the other two platforms `capabilities/desktop.json`
already declares, so the cross-platform claim is tested by CI instead of
assumed. They are compile-and-package smoke tests, not signed, notarized, or
QA'd releases.

- **Windows**: `tauri-action` produces an unsigned `.msi` (WiX) and/or `.exe`
  (NSIS) installer, per Tauri's default Windows bundle targets.
- **Linux** (`ubuntu-22.04`): produces `.deb`, `.AppImage`, and `.rpm`
  packages (Tauri's default Linux bundle targets), unsigned.
- **Linux system dependencies** — installed via `apt` before the build,
  matching the Debian/Ubuntu package list from the official prerequisites
  doc:
  <!-- Verified: https://v2.tauri.app/start/prerequisites/ (Linux > Debian tab) -->

  ```sh
  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  The prerequisites doc lists this package set generically for
  Debian/Ubuntu without a version-specific Ubuntu 22.04 variant; the
  `release-linux-experimental` job runs it on `ubuntu-22.04` (matching
  `check-native`'s existing runner conventions) and `continue-on-error: true`
  is the safety net if `libwebkit2gtk-4.1-dev` availability ever regresses on
  that image.

### Windows signing (design note only, not implemented)

Windows code signing (Authenticode) needs a code-signing certificate
(EV or OV) and either `signtool.exe` with a `.pfx`, or a cloud HSM-backed
signing service. Tauri v2 supports configuring this under
`bundle.windows.certificateThumbprint`/`digestAlgorithm`/`timestampUrl` for a
locally-installed certificate, or third-party signing providers. This is
purely a design note for later — no certificate exists yet, and no config
change is made in this plan.

## 4. Secrets inventory

All names below are GitHub Actions secret names only. No secret value is
ever committed to this repository; secrets are added through the repository
or environment settings in GitHub and consumed at CI time as `env:`/`with:`
values.

| Secret name | Used by | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | `release-macos`, `release-windows-experimental`, `release-linux-experimental` | GitHub-provided token; authorizes `tauri-action` to create/update the draft release and upload build artifacts. |
| `APPLE_CERTIFICATE` | `release-macos` (once signing is enabled) | Base64-encoded `.p12` Developer ID Application certificate, imported into a CI keychain for signing. |
| `APPLE_CERTIFICATE_PASSWORD` | `release-macos` (once signing is enabled) | Password protecting the `.p12` above. |
| `KEYCHAIN_PASSWORD` | `release-macos` (once signing is enabled) | Password for the temporary keychain CI creates to hold the imported certificate. |
| `APPLE_ID` | `release-macos` (once notarization is enabled, Apple ID method) | Apple ID used to submit the build for notarization. |
| `APPLE_PASSWORD` | `release-macos` (once notarization is enabled, Apple ID method) | App-specific password for the Apple ID above. |
| `APPLE_TEAM_ID` | `release-macos` (once notarization is enabled, Apple ID method) | Apple Developer Team ID, disambiguates the signing team. |
| `APPLE_API_ISSUER` | `release-macos` (once notarization is enabled, API key method — alternative to the Apple ID method) | App Store Connect API key issuer ID. |
| `APPLE_API_KEY` | `release-macos` (once notarization is enabled, API key method) | App Store Connect API key ID. |
| `APPLE_API_KEY_PATH` | `release-macos` (once notarization is enabled, API key method) | Path to the downloaded `.p8` API key file (the file itself is provisioned at build time, not committed). |

No secret is currently configured for `release-windows-experimental` or
`release-linux-experimental` beyond `GITHUB_TOKEN` — both jobs build
unsigned installers.

## 5. Known platform gaps

These are carried over from the native-open file policy work (plan 011) and
apply specifically to a future non-macOS release:

- The **executable-bit check is a no-op on Windows**: `is_executable` in
  `apps/desktop/src-tauri/src/commands.rs` returns `Ok(false)` unconditionally
  under `#[cfg(not(unix))]`, so on Windows the file-extension deny-list in
  `file_policy.rs` is the *only* gate against opening an executable natively
  — there is no `+x`-equivalent secondary check.
- The **identity re-check skips device/inode comparison on Windows**:
  `verify_target_unchanged` in `commands.rs` compares `(dev, ino)` under
  `#[cfg(unix)]`; on Windows this comparison does not run, so the
  swap-after-authorize protection that `dev`/`ino` provides on Unix is
  narrower there.

Both gaps mean the native-open policy needs a Windows-specific security
review — not just a compile check — before any Windows build is promoted
past `continue-on-error: true` experimental status. Put plainly: the
Windows and Linux jobs in this pipeline prove the app *compiles and
packages* on those platforms; they do not prove the file-access policy is
safe there. Treat their artifacts as compile-tested, not QA'd.
