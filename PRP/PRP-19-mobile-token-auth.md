# PRP-19 — Mobile token-auth variant (client-type-aware refresh)

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🟠 Med · **Size:** M
> **Addresses:** P1-BE-4 (master-prp §5.1/§7.1.4, decision D8) · **Depends on:** PRP-03 (refresh-token reuse detection / token family — this variant must preserve the same rotation/reuse semantics) · **Coordinates with:** PRP-04 (cookie/SameSite — web path unchanged), mobile PRP-27 (consumes the secure-storage contract)

## 1. Problem / current state
Auth is **cookie-only**. Login (`loginController`, `src/modules/auth/auth.controller.ts:24-36`) and refresh (`refreshController`, `:38-63`) always set/read the refresh token via the httpOnly cookie (`setRefreshTokenCookie`/`getRefreshTokenFromCookie`, `src/modules/auth/auth.cookies.ts`). The refresh token is **never** returned in the response body — `loginUser`/`refreshUserSession` produce a `refreshToken` (`src/modules/auth/auth.service.ts`) but the controller drops it into a cookie and returns only `{ user, accessToken }`.

A React Native client (D8, separate repo PRP-27) cannot use an httpOnly browser cookie. It needs the refresh token **in the JSON body** to store in device secure storage (iOS Keychain / Android Keystore) and to send back on refresh/logout. The web path must stay exactly as-is (httpOnly cookie is the better XSS posture for web — PRP-04).

## 2. Goal & non-goals
- **Goal:** detect the client type per request; for **mobile**, return the refresh token in the response body and accept it from the request body on `/auth/refresh` + logout; for **web**, keep the cookie path byte-for-byte unchanged. Identical hashing/rotation/reuse-detection for both (PRP-03).
- **Non-goals:** changing the access-token model (still a 15-min Bearer JWT for both clients), device/session management UI, push-token registration (mobile PRP-27/P6), any change to web behaviour.

## 3. Target design
### 3.1 Client-type detection
A small `getClientType(request) → 'web' | 'mobile'` helper (`src/modules/auth/auth.client.ts`): mobile if the request carries `X-Client: mobile` (preferred — explicit, set by the RN API client) **or** a `client: 'mobile'` field in the request body (fallback for endpoints with a body). Default `'web'` when absent, so existing web traffic is unaffected. The detected type is stashed on the request (`request.clientType`) for the controllers.

> **Decision — transport per client:** the *only* difference between the two paths is **where the refresh token lives** — cookie (web) vs. response body + request body (mobile). Everything else (access-token issuance, refresh-token hashing, rotation, family/reuse detection from PRP-03, TTLs) is shared. No separate endpoints; the same `/auth/login`, `/auth/refresh`, `/auth/logout` serve both, branching on `clientType`.

### 3.2 Login
`loginController`: after `loginUser(...)` returns `{ user, accessToken, refreshToken }`:
- **web:** `setRefreshTokenCookie(...)` (as today); body = `{ user, accessToken }`.
- **mobile:** **do not** set the cookie; body = `{ user, accessToken, refreshToken }`.

### 3.3 Refresh
`refreshController`: resolve the incoming refresh token by client type — web from the cookie (`getRefreshTokenFromCookie`), mobile from the request body (`request.body.refreshToken`). Feed it into the **same** `refreshUserSession(...)` (PRP-03's reuse-detection branch applies identically — a replayed rotated token still nukes the family and 401s, regardless of transport). On success:
- **web:** rotate the cookie; body = `{ user, accessToken }`.
- **mobile:** body = `{ user, accessToken, refreshToken: <rotated> }` (no cookie). The device replaces its stored token.

A missing mobile body token → `unauthorized` (mirror the web missing-cookie branch, `auth.controller.ts:42-48`; do not clear a cookie for mobile).

### 3.4 Logout
Today logout reads the refresh token from the **cookie only**; mobile has no cookie, so `/auth/logout` must also accept the token from the request body. Register the route as `fastify.post<{ Body: LogoutBody }>('/logout', { schema: logoutSchema, onRequest: [...] }, logoutController)` with a `LogoutBody { refreshToken?: string; client?: 'web' | 'mobile' }` body schema (all fields optional → web request shape unchanged). `logoutController`: resolve the refresh token from the cookie (web) **or `request.body.refreshToken`** (mobile) and pass it to `logoutUserSession`/`revokeRefreshToken` (those services are unchanged). For web, still `clearRefreshTokenCookie`; for mobile, return success and the client deletes its stored token (the server only needs to revoke the row). `logout-all` (`logoutAllController`) is unchanged — it keys off `authenticatedUserId`.

### 3.5 Schemas
Extend `auth.schema.ts`: `RefreshBody` and a new **`LogoutBody`** (the `/auth/logout` body, today unschematized) each gain an optional `refreshToken: { type: 'string' }` and an optional `client: { enum: ['web','mobile'] }`; add a `logoutSchema` wiring `LogoutBody` as the route's `body`. Login response schema documents the optional `refreshToken` (present for mobile). The `X-Client` header is documented in the route schema `headers` for Swagger. **No web request shape changes** (all new fields optional).

### 3.6 Secure-storage contract (for mobile PRP-27)
Document in this PRP for the mobile repo to implement:
- On login/refresh, persist `refreshToken` to Keychain (iOS, `kSecAttrAccessibleAfterFirstUnlock`) / EncryptedSharedPreferences or Keystore (Android). **Never** AsyncStorage.
- Send `X-Client: mobile` on every auth request; send the stored `refreshToken` in the body of `/auth/refresh` and `/auth/logout`.
- Keep the **access token in memory only** (mirror the web posture — `master-prp §5.1`); re-derive via refresh on cold start.
- Single-flight refresh on the device (mirror FE PRP-06) to avoid concurrent rotations that PRP-03 could read as reuse.

## 4. Implementation steps
1. **Detection helper:** add `src/modules/auth/auth.client.ts` (`getClientType`); add `clientType?: 'web' | 'mobile'` to `src/@types/fastify.d.ts` `FastifyRequest`.
2. **Controllers:** branch `loginController` / `refreshController` / `logoutController` (`src/modules/auth/auth.controller.ts`) on `getClientType(request)` per §3.2–3.4. Keep all web branches identical to current behaviour. `logoutController` now also reads `request.body?.refreshToken` (mobile) and passes it to `logoutUserSession`, falling back to the cookie for web.
3. **Schemas/types:** extend `RefreshBody`, add **`LogoutBody { refreshToken?: string; client?: 'web' | 'mobile' }`**, and extend the login response in `src/modules/auth/auth.schema.ts` and `auth.types.ts` (optional `refreshToken`, optional `client`, documented `X-Client` header). In `src/modules/auth/auth.routes.ts`, **type the logout route as `fastify.post<{ Body: LogoutBody }>('/logout', { schema: logoutSchema, ... }, logoutController)`** (today it has no body type/schema) so the body token is validated and typed.
4. **Reuse-detection coordination:** confirm `refreshUserSession` (post-PRP-03) is transport-agnostic — it already takes the raw token string, so no service change is needed; add a regression test that a mobile replay triggers family revocation.
5. **Rate-limit parity:** ensure the `/auth/refresh` per-route limiter (PRP-01) keys sensibly for mobile (still IP-based; fine).
6. **Docs:** record the §3.6 secure-storage contract here and cross-link from mobile PRP-27.

## 5. Files added / changed
- **Add:** `src/modules/auth/auth.client.ts`
- **Edit:** `src/modules/auth/auth.controller.ts`, `src/modules/auth/auth.routes.ts` (type `/auth/logout` as `post<{ Body: LogoutBody }>` + attach `logoutSchema`), `src/modules/auth/auth.schema.ts` (+ `LogoutBody`/`logoutSchema`), `src/modules/auth/auth.types.ts` (+ `LogoutBody`), `src/@types/fastify.d.ts`

## 6. Acceptance criteria
- [ ] A request with `X-Client: mobile` to `/auth/login` returns `{ user, accessToken, refreshToken }` and sets **no** `Set-Cookie`.
- [ ] A web login (no `X-Client`) returns `{ user, accessToken }` and sets the httpOnly cookie exactly as before (PRP-04 attributes unchanged).
- [ ] Mobile `/auth/refresh` reads the body token, rotates, and returns the new token in the body; web continues to use the cookie.
- [ ] A replayed (rotated) mobile token triggers PRP-03 family revocation and 401 — identical to web.
- [ ] Mobile logout revokes the token row given a body token; web logout still clears the cookie.
- [ ] No web request/response shape changed for existing clients (all additions optional).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- Manual (curl): `-H 'X-Client: mobile'` login → token in body, no cookie; refresh with that token in body → rotated token in body; replay the old one → 401 + family revoked. Repeat without the header → cookie path unchanged.

## 8. Risks & rollback
- **Don't weaken the web model (master-prp §7.6):** keep the paths cleanly separated; a default of `'web'` ensures any unlabeled request keeps the cookie posture. Never put the refresh token in the body for web.
- **Mobile token at rest:** the device contract (§3.6) is the security boundary for mobile — store only in secure storage; document it loudly for PRP-27.
- **Reuse false positives:** without device single-flight, concurrent mobile refreshes can look like reuse (same caveat as PRP-03 §8) — mandate single-flight in the mobile client.
- Rollback: revert the controller branching + schema additions; the cookie path is untouched, so web is unaffected.
