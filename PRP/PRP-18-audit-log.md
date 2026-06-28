# PRP-18 — Audit log

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🟠 Med · **Size:** M
> **Addresses:** P1-BE-5 (master-prp §5.5/§7.1.5, decision D22) · **Depends on:** PRP-12 (school context — supplies `schoolId` for school-scoped reads) · **Consumed by:** PRP-15, PRP-16, PRP-17, PRP-20, PRP-21 (all call `writeAudit()` on their critical actions)

## 1. Problem / current state
There is **no audit trail**. Critical actions — logins, school activation/lifecycle, permission edits, subscription changes, impersonation — leave no record, only transient app logs (`request.log.*`). Decision D22 mandates a **lightweight critical-actions audit log** (who/what/when) from day one; SuperAdmin (D15) needs an audit trail as a hard requirement. Field-level "old value" history is explicitly **not** required everywhere (fee history comes for free from year-scoping later).

Nothing in the schema models this; the other P1 PRPs (15/16/17/20/21) all reference a `writeAudit()` helper that must exist.

## 2. Goal & non-goals
- **Goal:** a single `AuditLog` model, a `writeAudit()` helper invoked on critical actions, a SuperAdmin cross-school read API, and a school-admin-scoped read API (an admin sees only their own school's entries).
- **Non-goals:** global field-level diff history (D22), log shipping/SIEM integration, tamper-proofing/signing (note as a future hardening), retention/rotation tuning beyond a documented default.

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```
model AuditLog {
  auditLogId  String   @id @default(uuid())
  actorUserId String?                       // null for system/cron-initiated actions
  action      String                         // e.g. "school.activate", "auth.login", "permission.update"
  entityType  String                         // "School" | "User" | "RolePermission" | "SchoolSubscription" | ...
  entityId    String?
  schoolId    String?                        // tenant scope; null for platform-level actions
  summary     String                         // short human-readable line
  metadata    Json     @default("{}")        // structured before/after, ip, impersonatedUserId, etc.
  createdAt   DateTime @default(now())
  @@index([schoolId, createdAt])
  @@index([actorUserId, createdAt])
  @@index([entityType, entityId])
  @@index([action])
}
```
No FK relations (kept decoupled so deleting a user/school never blocks or cascades the audit trail — the record must survive). `actorUserId`/`schoolId` are loosely-referenced strings.

### 3.2 `writeAudit()` helper
`src/modules/audit/audit.service.ts` exports:
```
writeAudit(fastify, {
  actorUserId?, action, entityType, entityId?, schoolId?, summary, metadata?
}): Promise<void>
```
It inserts one row. **Non-blocking by default:** failures are caught and logged (`fastify.log.error`) but never throw into the calling request path — an audit write must not fail a business action. (For the few cases where the audit *is* the point — e.g. impersonation in PRP-20 — callers may `await` and treat a failure as fatal; the helper returns the created id so a caller can choose.) A thin convenience wrapper records the common shape from a request: `auditFromRequest(request, { action, entityType, ... })` pulls `actorUserId` from `request.authenticatedUserId`, `schoolId` from `request.schoolContext` (PRP-12), and `ip` into metadata.

### 3.3 Instrumented actions (P1)
Wire `writeAudit()` at these call sites (owned by their respective PRPs, listed here for the contract):
- **auth:** `auth.login` (success), `auth.logout_all` — in `auth.service.ts`/controllers.
- **school lifecycle (PRP-16):** `school.request`, `school.activate`, `school.suspend`, `school.lock`, `school.extend_trial`, `school.reactivate`.
- **subscription (PRP-15):** `subscription.create`, `subscription.transition` (lazy + job), `subscription.extend_trial`, `invoice.mark_paid`.
- **RBAC (PRP-17):** `permission.update` (matrix edit).
- **SuperAdmin (PRP-20):** `impersonation.start` / `impersonation.end` (**mandatory**, awaited), plan CRUD.
- **owner/admins (PRP-21):** `admin.invite`, `ownership.transfer`.
Later phases add fee/marks edits + payments (master-prp §5.5).

### 3.4 Read APIs
New `src/modules/audit/{routes,controller,service,schema,types}.ts`:
- **SuperAdmin (cross-school):** `GET /api/developer/audit?schoolId=&actorUserId=&action=&entityType=&from=&to=&cursor=&limit=` — registered under the developer plugin's guarded subtree (`src/plugins/developer.plugin.ts`); cursor-paginated (by `createdAt`/`auditLogId`), newest-first. (The route may physically live in the developer module per PRP-20; the audit module provides the query service.)
- **School-admin (scoped):** `GET /api/school/audit` — under PRP-12's school-scoped plugin, guarded by `requirePermission('audit.read')`; the service **forces** `schoolId = request.schoolContext.schoolId` (never trusts a client-supplied schoolId — PRP-12 tenant-scoping rule) and excludes platform-level (`schoolId IS NULL`) rows.

Responses use `successResponse` with `{ items, nextCursor }`.

## 4. Implementation steps
1. **Schema:** add `AuditLog` to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name audit_log` then `pnpm prisma:generate`.
2. **Service + helper:** add `src/modules/audit/audit.service.ts` with `writeAudit`, `auditFromRequest`, and `queryAuditLogs(fastify, filters, scope)` (scope = `{ kind: 'platform' } | { kind: 'school', schoolId }`).
3. **Read module:** add `audit.routes.ts`/`audit.controller.ts`/`audit.schema.ts`/`audit.types.ts`. Register the school-scoped read route under PRP-12's school plugin; the cross-school read is wired by PRP-20 in the developer module (this PRP supplies `queryAuditLogs`).
4. **Instrument auth now:** add `auth.login`/`auth.logout_all` audit calls in `src/modules/auth/auth.service.ts` (the only critical actions already shipping); the other call sites land with their owning PRPs.
5. **Types/schemas:** `AuditLogListQuery`, `AuditLogItem` in `audit.types.ts`; Fastify schemas mirroring the `successEnvelope` helper in `src/modules/developer/developer.schema.ts`.

## 5. Files added / changed
- **Add:** `src/modules/audit/{routes,controller,service,schema,types}.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/modules/auth/auth.service.ts` (instrument login/logout-all), `src/plugins/index.ts` or the school plugin (register the scoped read route)

## 6. Acceptance criteria
- [ ] `AuditLog` table exists with the documented indexes.
- [ ] `writeAudit()` records a row and **never throws** into the caller (failure is logged); it returns the created id.
- [ ] A successful login produces an `auth.login` audit entry with actor + ip in metadata.
- [ ] SuperAdmin can list/filter audit entries across all schools, paginated newest-first.
- [ ] A school admin (`audit.read`) sees **only** their own school's entries; a client-supplied `schoolId` cannot widen the scope (PRP-12 rule).
- [ ] Deleting a user/school does not delete or block its audit rows (no FK cascade).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name audit_log` applies.
- Manual: log in → confirm `auth.login` row; hit the SuperAdmin audit list (filtered by `action=auth.login`); confirm a second school's admin cannot see the first school's rows.

## 8. Risks & rollback
- **Write amplification:** audit on hot paths could add latency — keep `writeAudit` fire-and-forget (non-awaited) except where the audit is the security control (impersonation). Consider a batched/async sink later if volume grows.
- **PII in metadata:** keep `metadata` to identifiers + before/after status, not raw secrets/passwords; document the convention.
- **Tamper-proofing** (append-only, signing) is out of scope; note it as future hardening.
- Rollback: stop calling `writeAudit`; drop the table (additive migration). The read routes are inert without data.
