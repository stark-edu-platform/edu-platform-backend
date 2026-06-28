# PRP-17 — Data-driven RBAC (Permission / RolePermission)

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P1-BE-3 (master-prp §5.1/§7.1.3, decisions D13/D14) · **Depends on:** PRP-12 (school context + the `requireSchoolContext` guard and `request.schoolContext` this resolves abilities into) · **Owns:** the canonical `resource.action` permission-string contract shared by FE PRP-10/PRP-11 and BE PRP-12 · **Feeds:** PRP-20 (permission editor API)

## 1. Problem / current state
Authorization is **role-presence only and hard-coded**: `requireDeveloper` (`src/middlewares/developer.middleware.ts:4-29`) checks `systemRole === DEVELOPER`; there is no school-role → permission resolution. PRP-12 introduces `requireSchoolContext` + `requirePermission(p)` and a `deriveSchoolPermissions(primaryRole, secondaryRoles[])` helper, but explicitly leaves the permission **map** as a code constant to be coordinated (PRP-12 §3, step 1). Decision D14 requires the map to be **data-driven and SuperAdmin-editable globally** (all schools inherit one matrix; per-school overrides deferred but storage must allow them later). D13 requires effective permissions to be the **union of primary + secondary roles**, scoped to the active school.

So today there is nowhere to store permissions, no seed matrix, and no SuperAdmin CRUD. This PRP is the **single owner of the permission-string vocabulary** — FE (PRP-10/11) and BE (PRP-12) must consume the exact same strings.

## 2. Goal & non-goals
- **Goal:** `Permission` + `RolePermission` tables (globally scoped), a seeded default role→permission matrix, ability resolution that unions primary+secondary roles within the active school, a `requirePermission(key)` guard backed by the DB (replacing PRP-12's constant map), and the canonical permission-string list published here.
- **Non-goals:** per-school permission overrides (schema is shaped to allow them later — `schoolId` reserved nullable on `RolePermission`), the SuperAdmin editor HTTP surface (PRP-20 — this PRP exposes the service methods), the FE consumption (PRP-10/11).

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```
model Permission {
  permissionId String   @id @default(uuid())
  key          String   @unique           // "resource.action" — the contract (see §3.4)
  resource     String                      // e.g. "student"
  action       String                      // e.g. "read"
  description  String?
  rolePerms    RolePermission[]
  createdAt    DateTime @default(now())
  @@index([resource])
}

model RolePermission {
  rolePermissionId String     @id @default(uuid())
  role             SchoolRole                  // ADMIN | STAFF | TEACHER | STUDENT | PARENT
  permissionKey    String                       // FK-by-key to Permission.key
  schoolId         String?                      // reserved: null = global default (v1 always null); future per-school override
  permission       Permission @relation(fields: [permissionKey], references: [key], onDelete: Cascade)
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt
  @@unique([role, permissionKey, schoolId])   // covers per-school override rows; does NOT enforce global-row uniqueness — see partial-index note
  @@index([role])
  @@index([schoolId])
}
```
> **Decision — global now, override-ready:** v1 only ever writes `schoolId = null` rows (the global matrix, D14). Resolution will later prefer a `schoolId`-specific row over the global one; the unique constraint + nullable `schoolId` make that a non-breaking addition. The DEVELOPER/SuperAdmin "system layer" is **not** stored here — it is governed by `requireDeveloper`/`PlatformUser` (PRP-20); RBAC rows cover only the five `SchoolRole`s.

> **Decision — enforce global-row uniqueness with a partial unique index:** `@@unique([role, permissionKey, schoolId])` does **not** prevent duplicate global rows, because Postgres treats `NULL`s as distinct — two `(ADMIN, 'member.invite', NULL)` rows both satisfy it, so the seed's idempotent upsert has no real conflict target to match on. Fix it by adding a **partial unique index over the global rows** via a **hand-written migration step** (Prisma 7 cannot express partial / `WHERE`-filtered uniques in the schema, so this SQL is added to the generated migration by hand):
> ```sql
> CREATE UNIQUE INDEX "RolePermission_role_permissionKey_global_key"
>   ON "RolePermission"(role, "permissionKey")
>   WHERE "schoolId" IS NULL;
> ```
> Keep the `@@unique([role, permissionKey, schoolId])` for the future per-school (`schoolId IS NOT NULL`) override rows. The seed upsert targets this partial index for global rows. (Alternative if a non-null target is preferred: use a sentinel non-null `schoolId` — e.g. an empty-string/"GLOBAL" marker — for global rows so the composite `@@unique` alone suffices; the partial index is the cleaner choice and is the one specified here.)

### 3.2 Ability resolution
`resolveAbilities(fastify, userSchool) → Set<string>` (in `src/modules/authz/`): given the active `UserSchool` (its `primaryRole` + `secondaryRoles[]`, already loaded by PRP-12's `requireSchoolContext`), query `RolePermission` for `role IN (primary, ...secondary) AND schoolId IS NULL` and union the `permissionKey`s (D13). Cache the global matrix in-process (it changes rarely; invalidate on SuperAdmin edits — a simple in-memory map keyed by role with a version counter bumped on write). PRP-12's `request.schoolContext.permissions` is populated from this resolver instead of the constant map.

### 3.3 `requirePermission(key)` guard
Replace PRP-12's constant-backed guard body with one that checks `request.schoolContext.permissions.has(key)` (the set now comes from the DB resolver). Signature and call sites are unchanged from PRP-12, so feature modules written against PRP-12 keep working. `requirePermission` throws `fastify.httpErrors.forbidden('Missing permission: <key>')` on a miss.

### 3.4 Canonical permission-string list (the contract)
`resource.action`, lowercase, dot-separated. **This list is authoritative; FE PRP-10/11 and BE PRP-12 must mirror it verbatim.** P1 seeds the cross-cutting set below; feature phases (P2+) extend it in their own PRPs by adding rows + appending here.

| Resource | Actions (P1 seed) |
|----------|-------------------|
| `school` | `read`, `update`, `manage_billing` |
| `subscription` | `read`, `manage` |
| `member` | `read`, `invite`, `update`, `deactivate` |
| `admin` | `invite`, `transfer_ownership` |
| `permission` | `read` |
| `audit` | `read` |
| `profile` | `read_self`, `update_self` |

**Default role → permission matrix (seed, all `schoolId = null`):**
- **ADMIN:** all of the above **except** `admin.transfer_ownership` and `school.manage_billing`, which are **owner-only** and enforced separately in PRP-21 (an ADMIN holds them only if they are the `ownerUserId`). Seed ADMIN with the full member/subscription/audit/permission-read set; the owner-only gate is a runtime check, not a separate role.
- **STAFF:** `school.read`, `member.read`, `profile.read_self`, `profile.update_self`.
- **TEACHER:** `school.read`, `profile.read_self`, `profile.update_self` (class/marks/attendance permissions arrive in P2/P3 PRPs).
- **STUDENT:** `school.read`, `profile.read_self`.
- **PARENT:** `school.read`, `profile.read_self` (multi-child fee/result read permissions arrive in P3/P4 PRPs).

> **Note:** the broad cross-school SuperAdmin powers (impersonation, lifecycle, global permission editing) are **not** in this matrix — they are DEVELOPER-gated (PRP-20). This matrix is strictly *within-school* ability.

### 3.5 Seeding
A `src/scripts/seedPermissions.ts` (mirrors `src/scripts/createDeveloper.ts`; wire `"seed:permissions"` in package.json) upserts the `Permission` rows from a single `PERMISSIONS` constant and the `RolePermission` default matrix from a `DEFAULT_ROLE_MATRIX` constant — both **exported from `src/modules/authz/permissions.ts`** so they are the literal source the seed and the FE-shared list derive from. Idempotent upserts so re-running is safe.

## 4. Implementation steps
1. **Schema:** add `Permission` + `RolePermission` to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name rbac_permissions` then `pnpm prisma:generate`. **Hand-edit the generated migration** to add the partial unique index `CREATE UNIQUE INDEX ... ON "RolePermission"(role, "permissionKey") WHERE "schoolId" IS NULL;` (Prisma 7 can't express it in-schema — see §3.1 decision); the global-row seed upsert relies on this constraint.
2. **Module `src/modules/authz/`:** add `permissions.ts` exporting the `PermissionKey` union/type, the `PERMISSIONS` list, and `DEFAULT_ROLE_MATRIX` (§3.4). **PRP-17 is the sole owner that populates `permissions.ts`** — PRP-12 ships only a placeholder/stub map (its §4 step 1), and this file **supersedes and replaces** it. After this lands, PRP-12's `permissions.ts` is a re-export/thin wrapper over the canonical lists here so the two PRPs (and the FE) never fork strings.
3. **Resolver:** add `src/modules/authz/abilities.service.ts` with `resolveAbilities(fastify, userSchool)` + the in-memory cache + a `bumpPermissionVersion()` invalidator.
4. **Guard:** update the `requirePermission(key)` implementation (the `src/middlewares/school.middleware.ts` PRP-12 introduces, or `src/modules/authz/` if co-located) to read from `request.schoolContext.permissions`, which `requireSchoolContext` now fills via `resolveAbilities`.
5. **SuperAdmin service methods:** add `listPermissions`, `getRoleMatrix`, `setRolePermissions(role, keys[])` to an `authz.service.ts` (HTTP surface lands in PRP-20); every mutation calls `bumpPermissionVersion()` + `writeAudit()` (PRP-18, `entityType: 'RolePermission'`).
6. **Seed:** add `src/scripts/seedPermissions.ts` + package.json script.
7. **Schemas/types:** `authz.schema.ts` (for PRP-20's editor), `authz.types.ts` (`PermissionKey`, `RoleMatrix`).

## 5. Files added / changed
- **Add:** `src/modules/authz/permissions.ts`, `src/modules/authz/abilities.service.ts`, `src/modules/authz/authz.service.ts`, `src/modules/authz/authz.schema.ts`, `src/modules/authz/authz.types.ts`, `src/scripts/seedPermissions.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), the PRP-12 `requirePermission` guard + its `permissions.ts` (re-export), `package.json`, `src/@types/fastify.d.ts` (only if a decorator/type changes)

## 6. Acceptance criteria
- [ ] `Permission` + `RolePermission` tables exist; the seed populates the §3.4 matrix idempotently (re-run safe).
- [ ] `resolveAbilities` returns the **union** of a user's primary + secondary role permissions for the active school (D13), proven by a dual-role test.
- [ ] `requirePermission('member.invite')` passes for ADMIN and 403s for TEACHER, using DB-backed permissions (not a code constant).
- [ ] Editing the matrix via the service method takes effect for **all** schools on the next request (cache invalidated).
- [ ] The permission-string list in `permissions.ts` is the single source; PRP-12's map re-exports it (no fork) and matches the FE PRP-10 list.
- [ ] Matrix mutations are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name rbac_permissions` + `pnpm seed:permissions` populate the matrix.
- Unit: `resolveAbilities` union for `{primary: TEACHER, secondary: [STAFF]}`; cross-role denial. Manual: flip a permission via the service, confirm a previously-403 request now passes.

## 8. Risks & rollback
- **String drift is the top risk (master-prp §7.6):** the FE/BE/mobile contract must not fork. Mitigate by making `permissions.ts` the only literal source and having PRP-12 + the FE shared module derive from it; review any new `resource.action` against this file.
- **Cache staleness:** the in-memory matrix cache must invalidate on every write (version bump); for multi-instance, a short TTL or a pub/sub invalidation is the follow-up (note in deploy docs).
- **Over-broad ADMIN:** keep `transfer_ownership`/`manage_billing` owner-gated at runtime (PRP-21), not granted by the ADMIN matrix row.
- Rollback: the resolver falls back to the (now re-exported) static map if the tables are empty; revert the guard change + drop the tables (additive migration).
