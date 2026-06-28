# PRP-03 — Refresh-token reuse detection (token family)

> **Status:** Proposed · **Phase:** 0 · **Severity:** 🔴 High · **Size:** M
> **Addresses:** SB1 · **Depends on:** none · **Interacts with:** frontend PRP-06 (single refresh single-flight)

## 1. Problem / current state
Rotation is implemented correctly and atomically (`refreshUserSession`, `src/modules/auth/auth.service.ts:182-246`, guarded `updateMany` in a transaction). But `findActiveRefreshToken` (`src/modules/auth/token.service.ts:104`) filters `revokedAt: null`, so replaying an **already-rotated/stolen** token just returns `null` → generic 401. There is no detection that a *previously valid* token was reused and **no revocation of the session family** — the core protection of rotating refresh tokens (OAuth 2.0 BCP / RFC 6819) is missing.

Current `RefreshToken` (`prisma/schema.prisma:219`) has no lineage columns: `id, userId, tokenHash, expiresAt, revokedAt, deviceInfo, ipAddress, createdAt`.

## 2. Goal & non-goals
- **Goal:** detect reuse of a rotated token and revoke the whole token family, forcing re-login; log/alert the event.
- **Non-goals:** device management UI; per-session naming.

## 3. Target design
Add lineage to `RefreshToken`:
- `familyId String` — shared across a login session's rotations (a new login starts a new family).
- `replacedById String?` — set on the old token when it rotates to a new one.

On refresh, look up the token **regardless of `revokedAt`**:
- **Active** (`revokedAt == null`, not expired) → rotate as today; set `old.replacedById = new.id`; new token inherits `familyId`.
- **Found but revoked** → this is reuse of a rotated token → `revokeRefreshTokenFamily(familyId)` + `log.warn({ userId, familyId }, 'refresh token reuse detected')` + throw `unauthorized`.
- **Not found** → 401 as today.

## 4. Implementation steps
1. **Schema:** add `familyId String` (indexed) and `replacedById String?` to `RefreshToken`. Run `pnpm exec prisma migrate dev --name refresh_token_family` then `pnpm prisma:generate`. Backfill existing rows with `familyId = id` in the migration (each legacy token is its own family).
2. **`token.service.ts`:**
   - `createRefreshTokenRecord(...)`: accept optional `familyId`; if absent, generate one (`crypto.randomUUID()`); persist it. Return `{ refreshToken, expiresAt, id, familyId }`.
   - Add `findRefreshTokenByHash(prisma, rawToken)` — same as `findActiveRefreshToken` but **without** the `revokedAt`/`expiresAt` filters (returns state).
   - Add `revokeRefreshTokenFamily(prisma, familyId)` (`updateMany where { familyId, revokedAt: null }`).
3. **`auth.service.ts` `refreshUserSession`:** replace the `findActiveRefreshToken` call with `findRefreshTokenByHash`; branch per the target design. In the rotation transaction, after creating the next token (inheriting `familyId`), set `replacedById` on the consumed token. Keep the atomic `updateMany` guard against double-rotation.
4. **`buildAuthTokens` (login path):** start a fresh `familyId` (let `createRefreshTokenRecord` generate it).

## 5. Files added / changed
- **Edit:** `prisma/schema.prisma` (+ migration), `src/modules/auth/token.service.ts`, `src/modules/auth/auth.service.ts`

## 6. Acceptance criteria
- [ ] Normal rotation still works; a refreshed token supersedes the old one.
- [ ] Replaying a rotated token revokes **all** tokens in that family and 401s.
- [ ] Concurrent double-refresh (same token, two requests) still resolves safely via the existing atomic guard (only one wins; the loser does not nuke the family — see Risks).
- [ ] Reuse events are logged with `userId` + `familyId`.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- Manual: login → capture cookie → refresh (get token B, cookie rotated) → replay token A → expect 401 **and** token B now revoked (next refresh with B also fails).

## 8. Risks & rollback
- **Benign races vs. real reuse:** a client firing two refreshes with the *same* token (no single-flight) can look like reuse. The atomic guard already serializes rotation; only treat a token as "reuse" if it is found **revoked** *and* its `replacedById` chain indicates it was already superseded. Frontend **PRP-06** removes accidental concurrent refreshes, lowering false positives.
- Rollback: revert service logic; the added nullable columns are harmless if unused.
