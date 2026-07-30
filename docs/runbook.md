# Runbook

## Production Docker image

The production image (`Dockerfile`) builds three entrypoints from one source tree:

- web: `node server.js` (Next.js standalone output)
- worker: `node dist/worker/main.js`
- signer: `node dist/signer/main.js`

Next compiles the web app itself. The worker and signer are plain Node/TypeScript
programs with no bundler, so they're compiled separately with `tsc` via
`tsconfig.server.json`, emitting to `dist/` (mirroring the source layout, e.g.
`worker/main.ts` -> `dist/worker/main.js`, `src/lib/db/client.ts` ->
`dist/src/lib/db/client.js`).

### `@/*` alias resolution: `tsc-alias`, not relative rewrites

`worker/main.ts` and `signer/main.ts` already import `src/lib` via relative paths
(`../src/lib/...`), but `src/lib` internally has 55 imports written through the
`@/*` tsconfig path alias (e.g. `import { x } from '@/lib/tron/address'`). `tsc`
type-checks path aliases but does not rewrite them at emit time, so a plain
`tsc -p tsconfig.server.json` produces JS files with the literal specifier
`'@/lib/tron/address'`, which Node's module resolver cannot find
(`Cannot find package '@/lib'`).

Two ways to fix this were considered:

1. Convert `src/lib`'s `@/` imports to relative paths.
2. Add `tsc-alias` as a post-processing step that rewrites the alias imports to
   relative paths in the compiled output.

**Decision: `tsc-alias`.** Rewriting 55 imports across `src/lib` by hand is a large,
unrelated refactor with real risk of introducing mistakes for no functional gain —
the alias exists precisely so application code doesn't need to hand-maintain
relative paths. `tsc-alias` solves the same problem mechanically as a build step:

```json
"build:server": "tsc -p tsconfig.server.json && tsc-alias -p tsconfig.server.json -f"
```

### The `-f` (`--resolve-full-paths`) flag is required, not optional

Running `tsc-alias` without `-f` only gets you halfway. By default it rewrites
`@/lib/tron/address` to `../../lib/tron/address` but does **not** append a file
extension. Because the repo is ESM (`"type": "module"` in `package.json`) and
`tsconfig.server.json` targets `"module": "ESNext"` / `"moduleResolution": "bundler"`,
`tsc` emits relative import specifiers exactly as written in the source — no `.js` is
ever added, whether the specifier came from an alias or was already relative
(e.g. `worker/main.ts`'s `import { createDb } from '../src/lib/db/client'`). Node's
ESM loader requires an explicit extension on relative specifiers, so any
extension-less relative import fails at runtime with
`ERR_MODULE_NOT_FOUND`, even after tsc-alias has "fixed" the alias.

`tsc-alias -f` appends `.js` to every relative specifier it touches — both the
alias-derived ones and plain relative ones already present in the source. This was
verified directly: compiling without `-f` and running
`node -e "import('./dist/src/lib/signer/keys.js')"` fails with
`Cannot find module '.../dist/src/lib/tron/address'`; compiling with `-f` resolves
and loads correctly, including the native/heavy dependencies transitively pulled in
(`@node-rs/argon2` via `src/lib/auth/password.ts`, `tronweb` via
`src/lib/tron/trongrid.ts`).

### Image layout

- `.next/standalone` + `.next/static` + `public/` -> the web server (`node server.js`)
- `dist/` (from `tsconfig.server.json`) -> worker and signer entrypoints
- `migrations/` -> so `scripts/migrate.ts` (compiled to `dist/scripts/migrate.js`) can run
  against the production database
- Full `node_modules` (from the `deps` stage, not the Next-traced subset in
  `.next/standalone/node_modules`) is copied last, overwriting the standalone
  subset, because the worker/signer/scripts import the full dependency graph
  (`pg`, `tronweb`, `@node-rs/argon2`, `drizzle-orm`, etc.), not just what Next's
  file tracer captured for the web app.
- Runs as a non-root `app` user (uid/gid 1001).
- No `.env` file or secret-bearing layer is copied into the image; all secrets are
  injected at container runtime via environment variables.
