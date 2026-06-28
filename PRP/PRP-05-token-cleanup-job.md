# PRP-05 — Expired/revoked token cleanup job

> **Status:** Proposed · **Phase:** 0 · **Severity:** 🟠 Med · **Size:** S
> **Addresses:** SB7 · **Depends on:** none

## 1. Problem / current state
`RefreshToken` and `Verification` rows are created but never deleted (`src/modules/auth/token.service.ts`). Both tables grow unbounded → storage bloat and degraded index performance over time. Both already have `expiresAt` indexes (`prisma/schema.prisma:231,246`).

## 2. Goal & non-goals
- **Goal:** periodically delete tokens/verifications that can never be used again.
- **Non-goals:** archival/audit retention (if reuse-detection forensics are wanted, keep revoked rows a bit longer — see retention below).

## 3. Target design
A small idempotent cleanup function plus a scheduler. Pick one mechanism per infra:
- **(a) In-process** `node-cron` (simplest; fine for a single instance).
- **(b) Script + external scheduler** (`pnpm cleanup:tokens` run by the platform's cron/k8s CronJob) — preferred for multi-instance so it runs once.
- **(c) `pg_cron`** if the DB supports it.

Retention: delete `RefreshToken` where `expiresAt < now()` OR `revokedAt < now() - 30d`; delete `Verification` where `expiresAt < now()` OR (`verifiedAt IS NOT NULL` AND `createdAt < now() - 7d`).

## 4. Implementation steps
1. Add `src/jobs/token-cleanup.job.ts` exporting `cleanupExpiredTokens(prisma)` using two `deleteMany` calls with the retention predicates; return the deleted counts and `log.info` them.
2. Add a runnable entry `src/scripts/cleanupTokens.ts` that builds a minimal Prisma client (reuse `db.plugin` pool config) and calls the job — wire `"cleanup:tokens": "tsx src/scripts/cleanupTokens.ts"` in `package.json` (mirrors `create:developer`).
3. Choose scheduling: document the external-cron command **or** add `node-cron` registration guarded by an env flag (`ENABLE_INPROCESS_CLEANUP`).

## 5. Files added / changed
- **Add:** `src/jobs/token-cleanup.job.ts`, `src/scripts/cleanupTokens.ts`
- **Edit:** `package.json` (script), deployment docs

## 6. Acceptance criteria
- [ ] Running the job removes expired/old-revoked rows and leaves active sessions + pending invites untouched.
- [ ] Job is idempotent and logs deleted counts.
- [ ] A documented way to schedule it exists.

## 7. Validation
- `pnpm typecheck`
- Manual: seed an expired `RefreshToken`, run `pnpm cleanup:tokens`, confirm it's gone and a live session token remains.

## 8. Risks & rollback
- Keep the revoked-row retention window long enough for PRP-03 reuse-detection forensics (30d suggested).
- Rollback: stop scheduling; the job is side-effect-only on dead rows.
