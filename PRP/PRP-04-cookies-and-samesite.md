# PRP-04 — @fastify/cookie + SameSite=Lax

> **Status:** Proposed (partially mitigated — cookies work; scoped to the library swap + `SameSite=Lax`) · **Phase:** 0 · **Severity:** 🟠 Med · **Size:** S
> **Addresses:** SB5, SB6 · **Depends on:** none · **Deployment fact:** FE & BE share a registrable domain

## 1. Problem / current state
- **SB5:** `src/modules/auth/auth.cookies.ts` hand-rolls cookie serialization/parsing (`serializeCookie`, `parseCookieHeader`, `appendSetCookie`, `getRefreshTokenFromCookie`). It works but is error-prone (quoted values, multi-`Set-Cookie` merging, encoding) and is maintenance you don't need — `@fastify/cookie` is the standard.
- **SB6:** the refresh cookie uses `SameSite=None` in production (`auth.cookies.ts:13`), which is the cross-site setting and exposes `/auth/refresh|logout|login` to CSRF (forced rotation, CSRF logout, login-CSRF). Since FE/BE are same-registrable-domain, `None` is unnecessary.

> **Already in place (verified 2026-06-28):** the hand-rolled cookie helpers function correctly today — this is a **swap** to `@fastify/cookie` + `None→Lax`, not new behavior. `@fastify/cookie` is still absent and `SameSite=None` (prod) still stands, so the steps are unchanged. The optional SB8 co-location (step 5) is also still pending — `loginUser` does not yet return `schools`.

## 2. Goal & non-goals
- **Goal:** replace hand-rolled cookie code with `@fastify/cookie`; set the refresh cookie to `SameSite=Lax`, closing the CSRF surface with zero token machinery.
- **Non-goals:** moving the access token into a cookie (it stays in memory — good XSS posture).

## 3. Target design
Cookie options (both envs unless noted): `httpOnly: true`, `sameSite: 'lax'`, `secure: NODE_ENV === 'production'`, `path: '/'`, `maxAge: REFRESH_TOKEN_TTL_DAYS * 86400`. Cookie name stays `refreshToken` (the frontend middleware `proxy.ts` and `clearRefreshTokenCookie` depend on it).

## 4. Implementation steps
1. `pnpm add @fastify/cookie`; register it in a plugin or `app.ts` (before auth routes).
2. Rewrite `auth.cookies.ts` to thin helpers over the plugin:
   - `setRefreshTokenCookie(reply, token)` → `reply.setCookie('refreshToken', token, options)`.
   - `clearRefreshTokenCookie(reply)` → `reply.clearCookie('refreshToken', { path: '/' })`.
   - `getRefreshTokenFromCookie(request)` → `request.cookies.refreshToken`.
   - Delete `serializeCookie` / `parseCookieHeader` / `appendSetCookie`.
3. Change `sameSite` to `'lax'` for all environments (drop the `None`/`Lax` branch). Keep `secure` gated on production.
4. Update controllers if their `setRefreshTokenCookie(fastify, reply, token)` signature changes (drop the now-unneeded `fastify` arg).
5. (Optional) co-locate SB8 here: add `userSchools` select to `loginUser` so the login response carries `schools` (lets frontend skip the extra `/auth/me`).

## 5. Files added / changed
- **Edit:** `src/modules/auth/auth.cookies.ts`, `src/modules/auth/auth.controller.ts`, `app.ts`/plugin, `package.json`

## 6. Acceptance criteria
- [ ] Login sets a `HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` in prod).
- [ ] Refresh + logout still work end-to-end; `proxy.ts` cookie-presence gate unaffected.
- [ ] Hand-rolled cookie functions are gone.
- [ ] Cross-site POST to `/auth/refresh` no longer carries the cookie.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- Manual: log in, inspect `Set-Cookie` (attributes), refresh, logout; confirm the frontend session survives reload.

## 8. Risks & rollback
- Verify the production domain truly shares a registrable domain with the API; if a cross-site need ever returns, switch to `None` + an Origin allow-list check on the cookie endpoints.
- Rollback: restore the previous `auth.cookies.ts`.
