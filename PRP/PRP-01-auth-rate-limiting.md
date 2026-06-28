# PRP-01 — Auth rate limiting & abuse control

> **Status:** Proposed · **Phase:** 0 · **Severity:** 🔴 High · **Size:** S–M
> **Addresses:** SB2 · **Depends on:** none · **Pairs with:** PRP-02

## 1. Problem / current state
`@fastify/rate-limit` is **not** a dependency and no throttle exists on `src/modules/auth/auth.routes.ts`. `/auth/login`, `/auth/refresh`, `/auth/setup-password`, and `/auth/setup-password/validate` are unbounded → credential stuffing / password brute force. Note: the `Verification` model already has an unused `attempts Int @default(0)` column (`prisma/schema.prisma:241`) intended for exactly this.

## 2. Goal & non-goals
- **Goal:** per-IP and per-`loginId` throttling on auth endpoints; consistent `429` envelope; foundation for soft lockout.
- **Non-goals:** full WAF / bot detection; CAPTCHA (can come later).

## 3. Target design
- Global, lenient limiter registered app-wide; strict per-route overrides on auth endpoints.
- `/auth/login` keyed by `ip + normalizedLoginId` (so one IP can't spray many accounts and one account can't be sprayed from one IP).
- `429` responses formatted through the existing `errorResponse` envelope via `errorResponseBuilder`.
- Health route (`/api/health`) and Swagger excluded.
- Use `Verification.attempts` to lock setup-token validation after N failures (defense-in-depth; the 256-bit token already makes guessing infeasible).

## 4. Implementation steps
1. `pnpm add @fastify/rate-limit`.
2. New `src/plugins/rate-limit.plugin.ts` (wrapped in `fastify-plugin`): register `@fastify/rate-limit` with a global `max`/`timeWindow` from new config keys, an `allowList` for health, and an `errorResponseBuilder` returning `errorResponse(429, 'Too many requests, please try again later')`.
3. Register it in `src/plugins/index.ts` (root scope, before the `/api` subtree).
4. In `auth.routes.ts`, add per-route `config.rateLimit` overrides:
   - `/auth/login`: `max: 8, timeWindow: '1 minute'`, custom `keyGenerator` → `${req.ip}:${normalizeLoginId(body.loginId)}`.
   - `/auth/refresh`: `max: 30, timeWindow: '1 minute'` (keyed by ip).
   - `/auth/setup-password` + `/validate`: `max: 10, timeWindow: '1 minute'`.
5. Add config keys to `src/config/shared-env.ts` (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`) with sane defaults.
6. (Optional, recommended) In `validateSetupToken`/`setPasswordFromInvite`, increment `Verification.attempts` on miss and reject after a threshold.

## 5. Files added / changed
- **Add:** `src/plugins/rate-limit.plugin.ts`
- **Edit:** `src/plugins/index.ts`, `src/modules/auth/auth.routes.ts`, `src/config/shared-env.ts`, `package.json`
- **(Optional) Edit:** `src/modules/auth/auth.service.ts`

## 6. Acceptance criteria
- [ ] Exceeding the login threshold returns `429` in the standard error envelope.
- [ ] Limit is per `ip+loginId`, not global.
- [ ] `/api/health` and Swagger are never rate-limited.
- [ ] Limits are configurable via env.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- Manual: `for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"loginId":"x@y.z","password":"wrong"}'; done` → see `429` after the threshold.

## 8. Risks & rollback
- **Multi-instance:** the default in-memory store is per-process. For >1 instance, back it with Redis (`@fastify/rate-limit` `redis` option). Note this in deploy docs.
- Rollback: remove the plugin registration; routes keep working unthrottled.
