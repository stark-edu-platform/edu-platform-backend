# PRP-20 — SuperAdmin console APIs (+ impersonation, PlatformUser)

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P1-BE-6 (master-prp §5.1/§7.1.6, decisions D15/D16) · **Depends on:** PRP-15 (subscription/plan services), PRP-16 (lifecycle transitions), PRP-17 (permission editor service), PRP-18 (audit read + write) · **Consumed by:** FE PRP-22 (SuperAdmin console UI)

## 1. Problem / current state
The developer module is minimal: `listSchools` + `createSchoolWithAdmin` (`src/modules/developer/developer.routes.ts:13-23`, `developer.service.ts:50-251`), guarded by `authenticate` + `authorizeDeveloper` (`src/plugins/developer.plugin.ts:9-19`). There is **no** schools filter/detail, no lifecycle actions, no subscription/plan management, no permission editor, no audit viewer, and **no impersonation** — all of which the SuperAdmin console (D15) requires. SuperAdmin identity is just `User.systemRole === DEVELOPER`; D15 also wants a `PlatformUser` concept (single account now, modeled so platform sub-roles like support/billing can be added later without a refactor).

The pieces this PRP orchestrates are built elsewhere (15/16/17/18); this PRP is the **HTTP surface** that wires them under `/api/developer` and adds the two net-new things: **impersonation** and **`PlatformUser`**.

## 2. Goal & non-goals
- **Goal:** extend `src/modules/developer/` with schools list/filter + detail, lifecycle actions (delegating PRP-16), subscription/plan management (PRP-15), permission-editor endpoints (PRP-17), an audit viewer (PRP-18), and **impersonation** ("login as" issuing a scoped, time-boxed, fully-audited token). Introduce a `PlatformUser` record over the DEVELOPER systemRole.
- **Non-goals:** building the subscription/permission/audit logic itself (owned by 15/17/18 — this PRP calls their services), the FE console (PRP-22), platform sub-role enforcement (modeled now, enforced later).

## 3. Target design
### 3.1 `PlatformUser` (D15)
A thin record layering platform identity over the existing DEVELOPER `User`:
```
enum PlatformRole { SUPER_ADMIN }   // single value in v1; SUPPORT/BILLING added later, no refactor

model PlatformUser {
  platformUserId String       @id @default(uuid())
  userId         String       @unique           // FK → User (must have systemRole DEVELOPER)
  platformRole   PlatformRole @default(SUPER_ADMIN)
  isActive       Boolean      @default(true)
  user           User         @relation(fields: [userId], references: [userId], onDelete: Cascade)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
}
```
`requireDeveloper` (`src/middlewares/developer.middleware.ts`) is extended (or a `requirePlatform(role?)` added alongside) to also confirm an active `PlatformUser` exists; `create:developer` seeding (`src/scripts/createDeveloper.ts`) also upserts the `PlatformUser`. v1 only ever has `SUPER_ADMIN`; the enum + role field are the seam for future support/billing sub-roles (D15) and they would later gate sub-surfaces of this console.

### 3.2 Console surface (all under the developer plugin's guarded `/api/developer` subtree)
Thin controllers delegate to the owning modules' services; responses use `successResponse`/`errorResponse`.

| Group | Endpoints | Delegates to |
|-------|-----------|--------------|
| Schools | `GET /developer/schools?status=&q=&cursor=&limit=` (filter/paginate the existing list), `GET /developer/schools/:schoolId` (detail + owner + subscription state) | extend `DeveloperService.listSchools`; PRP-15 `getSubscriptionState` |
| Lifecycle | `POST /developer/schools/:schoolId/activate` (`{ trialDays?, planId?, cadence? }`), `/suspend`, `/lock`, `/reactivate`, `/extend-trial` (`{ extraDays }`) | **PRP-16** `transitionSchoolStatus`; `activate`/`extend-trial` flow through PRP-15 |
| Plans | `GET/POST/PATCH /developer/plans` (per-student rate, allowed cadences, feature flags) | **PRP-15** plan CRUD |
| Subscriptions | `GET /developer/schools/:schoolId/subscription`, `POST .../invoices/:invoiceId/mark-paid` | **PRP-15** `getSubscriptionState`, `markInvoicePaid` |
| Permissions | `GET /developer/permissions`, `GET /developer/role-matrix`, `PUT /developer/role-matrix/:role` (`{ keys[] }`) | **PRP-17** `listPermissions`/`getRoleMatrix`/`setRolePermissions` |
| Audit | `GET /developer/audit?...` | **PRP-18** `queryAuditLogs({ kind: 'platform' })` |
| Impersonation | `POST /developer/impersonate` (`{ userId, reason? }`), `POST /developer/impersonate/stop` | §3.3 |

### 3.3 Impersonation ("login as")
SuperAdmin obtains a session **as a target user**, scoped and time-boxed, fully audited:
- Issue a **short-lived access token** (≤ the normal `ACCESS_TOKEN_TTL_MINUTES`, or a tighter `IMPERSONATION_TTL_MINUTES` config) whose JWT payload carries the target `sub` **plus** impersonation claims: `imp: true`, `impersonatorUserId: <superadmin>`, and a `jti`. Sign via the existing `fastify.jwt.sign` (`auth.service.ts:52`).
- **Do not** issue or rotate a refresh token for an impersonation session — it cannot be silently refreshed; it simply expires (forces re-initiation, bounding blast radius). The FE holds it in memory only.
- **Mandatory audit (PRP-18):** `impersonation.start` (awaited; if the audit write fails, the impersonation is refused) with `{ impersonatorUserId, targetUserId, reason, jti }` in metadata, and `impersonation.stop` on teardown.
- The impersonation claims travel on every downstream request, but **nothing reads them yet** — `requireAuth` (`src/middlewares/auth.middleware.ts`) currently verifies the JWT and uses only `sub`. So this PRP must, on the **verify side**: (1) **extend the JWT payload type** (wherever the signed payload is typed for `fastify.jwt`/`auth.service.ts`) to include the optional `imp?: boolean`, `impersonatorUserId?: string`, `jti?: string` claims — not just sign them in §3.3; and (2) **extend `requireAuth`** to read those claims off the verified token and populate `request.impersonation = { impersonatorUserId, jti }` (only when `imp === true`; otherwise leave it undefined). Add `request.impersonation` to `src/@types/fastify.d.ts`. Later phases can then surface "acting as" + restrict destructive actions while impersonating (forward-looking) by reading `request.impersonation`.

> **Decision — token, not password:** impersonation never touches the target's credentials. It mints a scoped JWT for the target `sub` and is auditable end-to-end. No refresh token = bounded, non-persistent session.

### 3.4 Schemas/types
Add Fastify schemas in `developer.schema.ts` (mirror its `successEnvelope` helper) for each endpoint group; query schemas for the filters/pagination; impersonation request/response schemas. Add types to `developer.types.ts`. Reuse PRP-17/18 schema fragments where they exist.

## 4. Implementation steps
1. **Schema:** add `PlatformRole` + `PlatformUser` to `prisma/schema.prisma` (+ `User.platformUser` back-relation); `pnpm exec prisma migrate dev --name platform_user` then `pnpm prisma:generate`. Update `src/scripts/createDeveloper.ts` to upsert the `PlatformUser` for the seeded DEVELOPER.
2. **Guard:** extend `requireDeveloper` (or add `requirePlatform`) in `src/middlewares/developer.middleware.ts` to also require an active `PlatformUser`; keep `authorizeDeveloper` decoration wiring (`developer.plugin.ts`) intact.
3. **Schools list/detail:** extend `DeveloperService.listSchools` with `status`/`q`/cursor filters; add `getSchoolDetail` (joins owner + PRP-15 subscription state). Add routes/controllers.
4. **Lifecycle routes:** add controllers calling PRP-16's `activateSchool`/`suspendSchool`/`lockSchool`/`reactivateSchool`/`extendTrial`.
5. **Plans + subscriptions:** add routes/controllers delegating to PRP-15 plan CRUD + `markInvoicePaid`/`getSubscriptionState`.
6. **Permissions editor:** add routes/controllers delegating to PRP-17 `listPermissions`/`getRoleMatrix`/`setRolePermissions`.
7. **Audit viewer:** add the `GET /developer/audit` route delegating to PRP-18 `queryAuditLogs`.
8. **Impersonation:** add `impersonation.service.ts` in the developer module (mint scoped JWT with `imp`/`impersonatorUserId`/`jti`, `await writeAudit('impersonation.start')`); routes/controllers for start/stop. Add `IMPERSONATION_TTL_MINUTES` to `shared-env.ts`.
8a. **Verify-side claims (not just sign):** extend the JWT payload type (the signed-payload type used with `fastify.jwt`/`auth.service.ts`) to carry optional `imp`/`impersonatorUserId`/`jti`, and extend `requireAuth` (`src/middlewares/auth.middleware.ts`) to read those off the verified token and set `request.impersonation = { impersonatorUserId, jti }` when `imp === true`. Add optional `request.impersonation` to `src/@types/fastify.d.ts`. (Today `requireAuth` reads only `sub` — nothing consumes the extra claims.)
9. **Schemas/types:** flesh out `developer.schema.ts` + `developer.types.ts` for all of the above.

## 5. Files added / changed
- **Add:** `src/modules/developer/impersonation.service.ts` (and split large additions into `developer.school.service.ts` etc. if the single service grows unwieldy)
- **Edit:** `prisma/schema.prisma` (+ migration), `src/modules/developer/{routes,controller,service,schema,types}.ts`, `src/middlewares/developer.middleware.ts`, `src/middlewares/auth.middleware.ts` (surface impersonation claims into `request.impersonation`), `src/modules/auth/auth.service.ts` (+ `auth.types.ts` — JWT payload type gains optional `imp`/`impersonatorUserId`/`jti`), `src/scripts/createDeveloper.ts`, `src/config/shared-env.ts`, `src/@types/fastify.d.ts`

## 6. Acceptance criteria
- [ ] `GET /developer/schools` supports `status`/`q`/cursor filtering; `GET /developer/schools/:id` returns owner + subscription state.
- [ ] Lifecycle actions move schools through the PRP-16 state machine; `activate` sets the trial via PRP-15.
- [ ] Plan + subscription endpoints create/list plans and mark invoices paid (PRP-15).
- [ ] The permission editor reads + updates the global role matrix (PRP-17) and the change takes effect platform-wide.
- [ ] The audit viewer lists cross-school entries with filters (PRP-18).
- [ ] Impersonation issues a short-lived, refresh-less token for the target user carrying `imp`/`impersonatorUserId`/`jti` claims, `requireAuth` surfaces them into `request.impersonation` on downstream requests, and a **mandatory** `impersonation.start` audit entry is written; if that audit write fails, impersonation is refused.
- [ ] A `PlatformUser(SUPER_ADMIN)` exists for the seeded DEVELOPER and is required by the guard.
- [ ] Every endpoint stays under the DEVELOPER/PlatformUser guard; none are reachable by a school USER.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name platform_user` + `pnpm create:developer` seeds the PlatformUser.
- Manual: as SuperAdmin, list/filter schools, activate one (trial set), edit the role matrix, view audit; impersonate a school admin → receive a scoped token, confirm `imp` claims + the audit entry; confirm the token cannot be refreshed.

## 8. Risks & rollback
- **Impersonation is high-blast-radius:** keep it refresh-less + short-TTL + mandatorily audited; consider (forward-looking) blocking destructive actions while `imp: true`. Never expose target credentials.
- **PlatformUser dual-source:** ensure `requireDeveloper` and `PlatformUser` don't drift — the guard checks both; seeding keeps them consistent. A DEVELOPER `User` without an active `PlatformUser` should be denied (fail-closed).
- **Surface depends on 15/16/17/18:** this PRP lands **after** them; if any slips, ship the wired subset and stub the rest behind a clear 501.
- Rollback: routes are additive under the existing guard; revert the developer-module additions + drop `PlatformUser` (additive migration).
