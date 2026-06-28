# PRP-73 — Backend unit-test harness (Vitest)

> **Status:** ✅ Done (implemented 2026-06-28) · **Phase:** 0 (tooling) · **Severity:** 🟠 Med · **Size:** S–M
> **Addresses:** missing test runner (`CLAUDE.md`: "Neither project has a test framework configured") · **Depends on:** none · **Unblocks:** the unit-test Validation steps in PRP-15 (`computeEffectiveAccess`), PRP-17 (ability resolution), PRP-45 (`computeStudentDues`), PRP-50 (`resolveGrade`), etc.
>
> **Implemented as:** stub at `src/testing/fastify-stub.ts` (kept under `src/` for typecheck + lint coverage rather than `test/helpers/`); added `tsconfig.build.json` and pointed `build` at it so `*.test.ts` + `src/testing/` stay out of `dist/`; added a third seed test `auth.service.test.ts` (`getCurrentUser`) for the no-DB service path. `coverage/` was already git-ignored. Verified green: `pnpm test` (12 tests, 3 files), `pnpm typecheck`, `pnpm test:coverage`, plus `lint`/`format`/`build`.

## 1. Problem / current state
The backend has **no test runner** (verified 2026-06-28): `package.json` has only lint/format/typecheck/build/prisma scripts — no `test` script, no `vitest`/`jest`/`node:test` config, no `*.test.ts` files. Static gating (ESLint + Prettier + `tsc --noEmit`) is the only safety net. Yet many PRPs' **Validation** sections call for unit tests of pure logic; there is nowhere to run them.

## 2. Goal & non-goals
- **Goal:** a working `pnpm test` (+ `test:watch`, `test:coverage`) running **Vitest** over `src/**/*.test.ts`, with the project's ESM + explicit-`.js`-extension imports resolving, a documented pattern for unit-testing **pure helpers** and **services** (Prisma mocked via the existing `fastify`-first-arg DI), and ≥2 green seed tests against existing code.
- **Non-goals:** integration tests against a real/test database, route-level `app.inject()` suites, E2E, CI wiring, coverage thresholds — all noted as follow-ons (§8). This is the **unit** harness only.

## 3. Target design
- **Runner:** Vitest — ESM-native (fits `"type": "module"`), `vi.mock`/DI ergonomics, and parity with the frontend harness (PRP-74). Add `vitest` + `@vitest/coverage-v8` to `devDependencies`.
- **ESM `.js`-extension resolution (the one wrinkle):** sources import siblings as `./x.js` (NodeNext) though the file is `x.ts`. Vite won't resolve that by default. Add a tiny `resolveId` plugin so Vitest resolves them exactly as `tsx` does at runtime:
  ```ts
  // vitest.config.ts
  import { defineConfig } from 'vitest/config';
  const tsJsExt = {
    name: 'ts-js-ext', enforce: 'pre' as const,
    async resolveId(source: string, importer?: string) {
      if (importer && source.startsWith('.') && source.endsWith('.js')) {
        const r = await this.resolve(source.slice(0, -3) + '.ts', importer, { skipSelf: true });
        if (r) return r;
      }
      return null;
    },
  };
  export default defineConfig({
    plugins: [tsJsExt],
    test: { environment: 'node', globals: true, include: ['src/**/*.test.ts'],
            coverage: { provider: 'v8', reportsDirectory: './coverage' } },
  });
  ```
- **Mocking strategy (no DB):** services take `fastify` as their first arg and reach `fastify.prisma`/`fastify.config`. Unit tests pass a typed **stub** `fastify` whose `prisma` methods are `vi.fn()`s — so service logic is tested without a database. Pure helpers are tested directly. A `test/helpers/fastifyStub.ts` factory standardizes this.
- **Convention:** co-locate `*.test.ts` beside the unit under test (e.g. `src/utils/api-response.test.ts`), mirroring the module-local style.

## 4. Implementation steps
1. `pnpm add -D vitest @vitest/coverage-v8`.
2. Add `vitest.config.ts` (the snippet above).
3. Add scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:coverage": "vitest run --coverage"`.
4. Add `test/helpers/fastifyStub.ts` exporting `makeFastifyStub(overrides?)` → a minimal typed object with `prisma` (methods as `vi.fn()`), `config`, and `httpErrors`.
5. **Seed tests against existing code** (green immediately, independent of unbuilt PRPs):
   - `src/utils/api-response.test.ts` — `successResponse`/`errorResponse` envelope shape.
   - `src/modules/auth/auth.utils.test.ts` — `isValidPassword` rules + `hashPassword`/`verifyPassword` scrypt round-trip.
6. Add `vitest/globals` to `tsconfig.json` `compilerOptions.types`; add `coverage/` to `.gitignore`.
7. Document the stub + `.js`-resolution pattern in `PRP/Tests/README.md` (or this file) as the template other PRPs follow.

## 5. Files added / changed
- **Add:** `vitest.config.ts`, `test/helpers/fastifyStub.ts`, `src/utils/api-response.test.ts`, `src/modules/auth/auth.utils.test.ts`
- **Edit:** `package.json` (devDeps + scripts), `tsconfig.json` (types), `.gitignore`

## 6. Acceptance criteria
- [x] `pnpm test` runs Vitest and is **green** with ≥2 real unit tests against existing code.
- [x] Source files importing siblings as `./x.js` resolve correctly under Vitest.
- [x] A service using `fastify.prisma` is unit-testable via `makeFastifyStub()` with **no database**.
- [x] `pnpm test:coverage` emits a report; `coverage/` is git-ignored.
- [x] `pnpm typecheck` still passes.

## 7. Validation
- `pnpm test` · `pnpm test:coverage` green; `pnpm typecheck` unaffected.

## 8. Risks & follow-ons
- **`.js`-extension resolution** is the main setup risk — verify the plugin against a service that imports a `./x.js` sibling before writing more tests.
- Keep unit tests **off the real DB** (DI stub). A separate integration PRP can add `app.inject()` + a disposable Postgres (testcontainers) later.
- **CI, not pre-commit:** run `pnpm test` in CI; don't add it to the `.githooks` pre-commit (keeps commits fast) — your call.
- Follow-ons: integration/route tests, CI wiring, coverage thresholds.
