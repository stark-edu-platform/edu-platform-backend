# PRP-12 — School-scoped authorization & tenant scoping

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🔴 High (forward-looking) · **Size:** L
> **Addresses:** SB-fwd · **Role:** P1 **prerequisite gate** — creates `requireSchoolContext`, `request.schoolContext`, and `src/plugins/school.plugin.ts`, which **PRP-15/16/17/18 and all of P2 hard-depend on**; this must land before any school module ships. · **Coordinates with:** frontend PRP-10 — **contract coordination only** (shared `resource.action` permission strings), **not** a build dependency.

## 1. Problem / current state
The only authorization guard is `requireDeveloper` (`src/middlewares/developer.middleware.ts`), used by the developer plugin. There is **no school-role / permission guard** and **no tenant-scoping** layer. Today that's fine (only developer + auth endpoints exist), but the moment school modules (students, staff, fees, attendance…) land, every endpoint needs: (1) "is this user a member of this school?", (2) "does their role grant this permission?", (3) "scope all queries to *their* `schoolId`, never a client-supplied one." Retrofitting tenant isolation after features exist is the hardest, riskiest kind of change — so lock the contract now.

Relevant model: `UserSchool` (`prisma/schema.prisma:91`) — `@@unique([userId, schoolId])`, `primaryRole: SchoolRole`, `secondaryRoles: UserSchoolSecondaryRole[]`, `isActive`. `SchoolRole = ADMIN | STAFF | TEACHER | STUDENT | PARENT`.

## 2. Goal & non-goals
- **Goal:** a reusable `requireSchoolContext` + `requirePermission(permission)` guard pair and a tenant-scope resolver, mirroring the frontend permission model (PRP-10) so FE and BE agree on the same `resource.action` strings.
- **Non-goals:** building the actual school feature modules; per-field ACLs.

## 3. Target design
- **School context resolution:** derive the active `schoolId` from a trusted source — the authenticated user's `UserSchool` membership selected via a route param / subdomain / `X-School-Id` header — then **verify membership server-side**. Attach `request.schoolContext = { schoolId, role, permissions }`.
- **Permission model (shared shape with FE PRP-10):** `deriveSchoolPermissions(primaryRole, secondaryRoles[]) → Set<Permission>`. The frontend mirrors the same `resource.action` strings.

> **Decision — permission-string ownership:** PRP-12 ships **only a `Permission` type + a placeholder/stub map** to unblock the guard signatures and FE coordination. The **canonical `resource.action` list and the populated role→permission matrix are owned by PRP-17**, which supersedes this stub. PRP-12 must **not** fork or hand-maintain the strings — once PRP-17 lands, `permissions.ts` re-exports from it.
- **Guards:**
  - `requireSchoolContext` (onRequest) — resolves + validates membership, 403 if not an active member.
  - `requirePermission(p)` — 403 unless `schoolContext.permissions.has(p)`. `DEVELOPER` systemRole bypass policy decided explicitly (recommend: developers do **not** implicitly get school data access; they use developer endpoints).
- **Tenant scoping:** a thin helper so services filter by `request.schoolContext.schoolId`; client-supplied `schoolId` is never trusted for authorization.
- **Plugin pattern:** a `school.plugin.ts` mirroring `developer.plugin.ts` — `addHook('onRequest', authenticate)` then `addHook('onRequest', requireSchoolContext)` for the `/school`-scoped subtree.

## 4. Implementation steps
1. Add `src/modules/authz/permissions.ts` — the `Permission` **type** + `deriveSchoolPermissions()` + a **placeholder** `ROLE_PERMISSIONS: Record<SchoolRole, Permission[]>` (minimal stub, **owned and populated by PRP-17** — do not maintain the canonical list here). Coordinate strings with frontend `PRP-10`.
2. Add `src/middlewares/school.middleware.ts` — `requireSchoolContext` and `requirePermission(p)`; extend the Fastify request type in `src/@types/fastify.d.ts` with `schoolContext`.
3. Add `src/plugins/school.plugin.ts` scaffold (no routes yet) demonstrating the hook wiring + one example guarded route in a `__example` module.
4. Document the contract in this PRP's "Decision" section: how `schoolId` is supplied, developer bypass policy, and the canonical permission list.
5. Add unit tests for `deriveSchoolPermissions` and a cross-tenant denial test.

## 5. Files added / changed
- **Add:** `src/modules/authz/permissions.ts`, `src/middlewares/school.middleware.ts`, `src/plugins/school.plugin.ts`
- **Edit:** `src/@types/fastify.d.ts`, `src/plugins/index.ts`

## 6. Acceptance criteria
- [ ] A user with no active `UserSchool` for the requested school gets `403`.
- [ ] A member lacking the required permission gets `403`; one with it passes.
- [ ] Services receive `schoolId` from `schoolContext`, not from client input.
- [ ] Permission strings match the frontend's (PRP-10).
- [ ] Developer-bypass policy is documented and tested.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- Tests: cross-tenant access denied; role/permission matrix.

## 8. Risks & rollback
- This is a **contract** decision — get FE/BE agreement on the permission strings and the `schoolId` transport before building features. Cheap now, expensive later.
- Rollback: the scaffold is inert until school routes use it.
