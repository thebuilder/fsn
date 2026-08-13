# CLAUDE.md

FSN is a web and desktop tribute to SGI's File System Navigator: it renders one
directory at a time as a deterministic WebGL city. See `README.md` for what
the app does and how to run it locally; this file is about how to work on it
correctly.

## Workspace map

- `apps/web` (`@fsn/web`) — browser adapter. File System Access API, Vercel
  Analytics. Read-only: it cannot edit files, only browse them.
- `apps/desktop` (`@fsn/desktop`) — Tauri v2 shell with a Rust backend in
  `src-tauri/`. The only place file edits happen.
- `packages/core` (`@fsn/core`) — platform-neutral filesystem model, search,
  and parsers. **No DOM, no three.js, no Tauri imports.** It must run
  anywhere, including inside the Rust-adjacent test tooling.
- `packages/app` (`@fsn/app`) — navigator controller, WebGL scene, viewers,
  shared shell and styles. Consumed by both apps.

Two hard rules: `packages/core` stays platform-neutral, and neither package
gets a build step (see below) — apps compile them, not the other way around.

`packages/app` and `packages/core` have **no `build` script**. Their
`exports` in `package.json` point straight at `./src/*.ts`. The apps compile
them via Vite. Do not add a `build` script or a dist output to either
package — that would be fixing something that isn't broken.

## Verify your work

| Purpose | Command | Success |
|---|---|---|
| Full check | `pnpm install --frozen-lockfile` then `pnpm check` | exit 0 (runs `turbo run typecheck test build`) |
| One package | `pnpm --filter @fsn/core test` (or `@fsn/app`, `@fsn/web`, `@fsn/desktop`) | exit 0 (vitest) |
| Rust backend | from `apps/desktop/src-tauri`: `cargo fmt --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings` | all exit 0 |

These are the exact commands CI runs (`.github/workflows/ci.yml`). Run the
relevant one before calling anything done.

## Conventions

- TypeScript strict mode. 2-space indent, double quotes, semicolons.
- No linter or formatter config exists today. Don't assume Prettier/ESLint
  conventions beyond what's already in the file you're editing; match the
  surrounding code by eye. (If a `biome.json` has since appeared at the root,
  a linter exists now — run `pnpm lint` and ignore this paragraph.)
- Comments explain *why*, in full sentences, often a short paragraph.
  Trivial restatement-of-code comments are not this codebase's style. See
  `packages/app/src/navigator.ts:121-138` (the `RouteIntent` doc comment) or
  `packages/app/src/scene.ts:1701-1708` (the flight/orbit-controls handoff)
  for the level of explanation expected.
- Tests are colocated `*.test.ts` files run with vitest: behavior-focused,
  no snapshot tests, no mocking-the-thing-you're-testing. See
  `packages/core/src/parsers/parsers.test.ts` for the house style.
- Commit messages: lowercase conventional prefix (`feat:`, `fix:`, `ci:`,
  `docs:`, ...) followed by a plain-language clause describing the effect,
  not the mechanism. Real examples from this repo's history:
  `fix: stop a slow directory writing its crumb twice`,
  `feat: make a search result a destination rather than a highlight`.

## Deliberate absences

- **No Turbopack.** Turborepo orchestrates tasks; Turbopack (the Next.js
  bundler) is intentionally not used — FSN is a Vite app, and Tauri supports
  Vite directly. Don't suggest migrating to Next.js or swapping the bundler.
- **No linter.** See Conventions above; this may change later.
- **The web app is read-only by design.** Only `apps/desktop` edits files.
  Don't add file-write affordances to `apps/web`.

## Security invariants

- All file bytes and file/directory names read from disk are untrusted
  input. Treat them accordingly in parsers and viewers.
- DOM rendering is strictly `textContent`-based, via the `el()` helper in
  `packages/app/src/viewers/dom.ts`. Never build HTML by string
  concatenation or use `innerHTML` with untrusted content.
- The desktop Rust layer validates every filesystem path against a
  Rust-owned active root before touching disk — see
  `apps/desktop/src-tauri/src/grant.rs`. Never trust a path handed in from
  the webview without that check.
