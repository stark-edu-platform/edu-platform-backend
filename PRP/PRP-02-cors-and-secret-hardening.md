# PRP-02 — CORS allow-list + env/secret hardening

> **Status:** Proposed (partially mitigated — scoped to the remaining hardening) · **Phase:** 0 · **Severity:** 🔴 High · **Size:** S
> **Addresses:** SB3, SB4 · **Depends on:** none

## 1. Problem / current state
- **SB3:** `ALLOWED_ORIGINS` defaults to `'*'` (`src/config/shared-env.ts:21`). With `credentials: true` (`src/app.ts:54-57`), `parseAllowedOrigins` calls `callback(null, true)` for *any* origin when `'*'` is present, so the server reflects `Access-Control-Allow-Origin: <origin>` with credentials. A forgotten env in production = any site can make credentialed calls.
- **SB4:** `JWT_SECRET` has no `minLength` (`shared-env.ts:32`) and `readSharedEnv()` defaults it to `''` (`:92`); `DATABASE_URL` likewise defaults to `''` with a `// need to think about this` note (`:83`). A missing/empty secret silently degrades token signing.

> **Already in place (verified 2026-06-28):** the `parseAllowedOrigins` allow-list parser (`app.ts:11-35`) and credentialed CORS (`app.ts:54-57`) already exist — this PRP **hardens** them, it does not build CORS. The insecure `*`/empty default and the missing `JWT_SECRET` strength check are all still present, so every step below stands.

## 2. Goal & non-goals
- **Goal:** fail-closed configuration — refuse to boot in production with a weak/empty secret or a wildcard credentialed CORS.
- **Non-goals:** per-tenant CORS, dynamic origin management UI.

## 3. Target design
- `JWT_SECRET`: required, `minLength: 32`, no default.
- `ALLOWED_ORIGINS`: explicit comma-separated list. `'*'` is allowed in development only; in production a wildcard (or empty) throws at boot.
- `readSharedEnv()` stops defaulting secrets to `''` (it feeds `prisma.config.ts` and scripts); throw if absent.

## 4. Implementation steps
1. `shared-env.ts`: set `JWT_SECRET: { type: 'string', minLength: 32 }`; keep it in `sharedRequiredEnv`. (`@fastify/env` will now reject short/missing secrets.)
2. `app.ts` `parseAllowedOrigins`: if `NODE_ENV === 'production'` and (`parsedOrigins` is empty or contains `'*'`), `throw new Error('ALLOWED_ORIGINS must be an explicit allow-list in production')`.
3. `readSharedEnv()`: remove the `?? ''` fallbacks for `JWT_SECRET` and `DATABASE_URL`; throw a clear error if missing (keeps prisma tooling honest). Resolve the `// need to think about this` comment.
4. Update `.env.example` / deployment docs to require an explicit origin list and a 32+ char secret.

## 5. Files added / changed
- **Edit:** `src/config/shared-env.ts`, `src/app.ts`, `.env.example` (if present)

## 6. Acceptance criteria
- [ ] Boot fails fast in production if `JWT_SECRET` is missing or `< 32` chars.
- [ ] Boot fails fast in production if `ALLOWED_ORIGINS` is `*` or empty.
- [ ] Unknown origins are rejected by CORS; configured origins work with credentials.
- [ ] Development still allows `*` for convenience.

## 7. Validation
- `pnpm typecheck && pnpm build`
- Manual: start with `NODE_ENV=production JWT_SECRET=short` → expect boot error. Start with a valid 32+ secret and explicit origins → boots; a `curl` with a disallowed `Origin` header is rejected.

## 8. Risks & rollback
- Low risk; primarily tightens validation. Coordinate the env changes with whoever owns the deploy environment so production has the new values set **before** rollout.
