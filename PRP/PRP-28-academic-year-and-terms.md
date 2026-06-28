# PRP-28 — Academic year & configurable terms

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🔴 High · **Size:** M
> **Addresses:** P2-BE-28 (implementation-plan §P2, master-prp §5.7/§6, decision D18) · **Depends on:** PRP-16 (school lifecycle — years/terms hang off an activated `School`), PRP-17 (RBAC — `academic.*` permission strings), PRP-12 (school context / tenant scoping the routes layer on) · **Feeds:** PRP-29 (classes/sections/subjects are year-scoped), PRP-32 (enrollment is per-year), and every P2+ academic feature (attendance/fees/exams all align to a year + term)

## 1. Problem / current state
The platform has **no concept of an academic year or a term**. The schema models tenancy and identity (`School`, `UserSchool`, profile tables, `Student`, `ParentStudent`) but nothing time-scopes operational data. Decision **D18** makes this foundational: *all* operational data is **academic-year-scoped** (so year-end promotion + year-on-year rollover/archival are possible — PRP-32), and each school configures its **own term shape** (CBSE 2-term, 3 trimesters, 4 quarters…), to which fees (P4), exams (P5) and report cards align.

Because every P2+ entity will carry an `academicYearId` (classes, enrollments, assignments, fee plans, exams…), this is a **hard prerequisite** for the rest of Phase 2 — it must land first so PRP-29/30/31/32/33 can reference a concrete `AcademicYear` / `Term` model and a "current year" resolution helper. Today there is also no module under `src/modules/` for any school-scoped feature; this PRP establishes the first one and the pattern the others copy.

## 2. Goal & non-goals
- **Goal:** `AcademicYear` (per-school, exactly one `isCurrent` at a time) + `Term` (per-school, per-year, configurable count/shape) models; a `src/modules/academic/` module with admin CRUD; a `resolveCurrentAcademicYear(fastify, schoolId)` service helper that the rest of P2 uses to default the active year; the `academic.*` permission strings (added to PRP-17's matrix).
- **Non-goals:** classes/sections/subjects (PRP-29), enrollment/promotion (PRP-32), the year-end **rollover/archival** mechanics themselves (PRP-32 owns the promotion job; this PRP only provides the year model + "set current" transition it drives), any fee/exam term-alignment (P4/P5 consume `termId`), the FE management screens (PRP-35).

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```prisma
enum TermKind {
  SEMESTER     // CBSE 2-term
  TRIMESTER    // 3
  QUARTER      // 4
  CUSTOM       // arbitrary, label-driven
}

model AcademicYear {
  academicYearId String   @id @default(uuid())
  schoolId       String
  name           String                          // e.g. "2026-27"
  startDate      DateTime
  endDate        DateTime
  isCurrent      Boolean  @default(false)         // exactly one true per school (enforced in service, §3.3)
  isArchived     Boolean  @default(false)         // set when rolled over (PRP-32)
  termKind       TermKind @default(SEMESTER)
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  terms          Term[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
  @@index([schoolId, isCurrent])
}

model Term {
  termId         String       @id @default(uuid())
  schoolId       String                            // denormalized for tenant scoping (house convention)
  academicYearId String
  name           String                            // "Term 1", "Quarter 2", …
  sequence       Int                               // 1-based order within the year
  startDate      DateTime
  endDate        DateTime
  academicYear   AcademicYear @relation(fields: [academicYearId], references: [academicYearId], onDelete: Cascade)
  school         School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@unique([academicYearId, sequence])
  @@index([schoolId])
  @@index([academicYearId])
}
```
Add the back-relations `academicYears AcademicYear[]` and `terms Term[]` to `School` (mirrors the existing `students Student[]` etc.). Import `TermKind` from `src/generated/prisma/enums.js`; `schoolId` denormalization follows the existing `AdminProfile`/`Student` pattern (every child row carries `schoolId` for indexing/scoping).

> **Decision — single current year, service-enforced:** Postgres has no clean partial-unique on a boolean, so "exactly one `isCurrent` per school" is enforced in `setCurrentAcademicYear` (a transaction that flips the others off), not by a DB constraint. The `@@index([schoolId, isCurrent])` keeps the lookup cheap. Years are **never deleted** once they carry data — they are archived (`isArchived`) by PRP-32's rollover.

### 3.2 Module layout (`src/modules/academic/`)
First school-scoped feature module; follows the house split exactly and is registered under PRP-12's school-scoped plugin.
- `academic-year.routes.ts` — wiring + Fastify schemas (this PRP focuses on years/terms; PRP-29 adds `classes.routes.ts` etc. to the **same** module).
- `academic-year.controller.ts` — thin HTTP in/out.
- `academic-year.service.ts` — Prisma access + the transitions in §3.3 (`fastify` first arg).
- `academic-year.schema.ts` — JSON schemas, `successEnvelope` style from `src/modules/developer/developer.schema.ts`.
- `academic-year.types.ts` — `CreateAcademicYearBody`, `ConfigureTermsBody`, `AcademicYearListItem`; enums from `src/generated/prisma/enums.js`.

### 3.3 Services & routes
`academic-year.service.ts` exports (all take `fastify`, all scope by the caller's `request.schoolContext.schoolId` — never a client-supplied id, per PRP-12):
- `createAcademicYear(fastify, schoolId, { name, startDate, endDate, termKind })` — validates `startDate < endDate`, rejects overlap with an existing non-archived year (`fastify.httpErrors.conflict`), and on the school's **first** year sets `isCurrent: true`.
- `configureTerms(fastify, schoolId, academicYearId, terms[])` — replaces the year's terms in a transaction; validates `terms.length` against `termKind` (2/3/4; `CUSTOM` = any ≥1), contiguous `sequence`, and that every term window sits inside the year window. Idempotent (full replace).
- `setCurrentAcademicYear(fastify, schoolId, academicYearId)` — transaction: set this year `isCurrent: true`, all others for the school `false`; audited (`writeAudit`, PRP-18, `action: 'academic_year.set_current'`).
- `listAcademicYears` / `getAcademicYear` (with terms) / `archiveAcademicYear` (used by PRP-32 rollover).
- **`resolveCurrentAcademicYear(fastify, schoolId) → AcademicYear`** — the shared helper the rest of P2 imports to default the active year; throws `fastify.httpErrors.preconditionFailed('No active academic year configured')` if none. Export it from the service so PRP-29/32 import it via `'../academic/academic-year.service.js'`.

Routes (registered in the school-scoped subtree, each guarded with `requirePermission`, PRP-17):
- `POST /api/school/academic-years` (`academic.manage`)
- `GET /api/school/academic-years` (`academic.read`)
- `GET /api/school/academic-years/:academicYearId` (`academic.read`)
- `PUT /api/school/academic-years/:academicYearId/terms` (`academic.manage`)
- `POST /api/school/academic-years/:academicYearId/set-current` (`academic.manage`)

All mutating routes also opt into `fastify.requireWritableSchool` (PRP-15) so a `READ_ONLY`/`LOCKED` school cannot edit its calendar.

### 3.4 Permission strings (extends PRP-17 §3.4)
Append to the canonical list and the seed matrix (PRP-17 owns the file `src/modules/authz/permissions.ts`; this PRP adds rows + a line to that contract table):

| Resource | Actions (P2) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `academic` | `read`, `manage` | read+manage | read | read | – | – |

## 4. Implementation steps
1. **Schema:** add `TermKind`, `AcademicYear`, `Term` + the two `School` back-relations to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name academic_year_and_terms` then `pnpm prisma:generate`.
2. **Module scaffold:** add `src/modules/academic/academic-year.{routes,controller,service,schema,types}.ts` following the module split (controllers thin; service `fastify`-first). Import enums from `src/generated/prisma/enums.js`; import `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Services:** implement the §3.3 functions, including `resolveCurrentAcademicYear` (the shared P2 helper) and the `setCurrentAcademicYear` transaction. Use `fastify.httpErrors.*` for all error paths.
4. **Routing:** register `academic-year.routes.ts` under PRP-12's school-scoped plugin (`src/plugins/school.plugin.ts`); guard each route with `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations.
5. **Permissions:** add the `academic.read` / `academic.manage` rows + matrix entries to `src/modules/authz/permissions.ts` (PRP-17) and re-run `pnpm seed:permissions`.
6. **Audit:** call `writeAudit()` (PRP-18) on `createAcademicYear`, `configureTerms`, `setCurrentAcademicYear`, `archiveAcademicYear`.
7. **Schemas/types:** add Fastify JSON schemas (`successEnvelope` style) + the request/response types.

## 5. Files added / changed
- **Add:** `src/modules/academic/academic-year.routes.ts`, `academic-year.controller.ts`, `academic-year.service.ts`, `academic-year.schema.ts`, `academic-year.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `academic.*`)

## 6. Acceptance criteria
- [ ] `AcademicYear` + `Term` tables exist with the documented unique constraints + indexes; both carry `schoolId`.
- [ ] Creating the first year for a school sets `isCurrent: true`; creating a second leaves it `false` until `set-current` is called.
- [ ] `set-current` flips exactly one year `isCurrent` per school (verified by a test that two years can't both be current).
- [ ] `configureTerms` rejects a term count that contradicts `termKind` (e.g. 3 terms on `SEMESTER`) and any term window outside the year window.
- [ ] `resolveCurrentAcademicYear` returns the current year and throws `412` when none is configured.
- [ ] All routes are tenant-scoped (a client-supplied `schoolId` is ignored) and permission-guarded; mutations 403/402 on a non-writable school (PRP-15).
- [ ] Year/term mutations are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name academic_year_and_terms` applies cleanly; `pnpm seed:permissions` adds `academic.*`.
- Manual: create a year → configure 3 trimesters → set-current → `resolveCurrentAcademicYear` returns it; attempt overlapping year → `409`; attempt term outside the window → `400`.

## 8. Risks & rollback
- **Foundational ordering:** every other P2 PRP references `AcademicYear`/`Term` and `resolveCurrentAcademicYear`; land this **first**. Until it lands, PRP-29/32 cannot compile their year-scoped FKs.
- **"Current year" correctness:** the single-current invariant is service-enforced, not DB-enforced — the `setCurrentAcademicYear` transaction is the only writer of `isCurrent`; never set it via raw updates elsewhere. Cover it with the two-year test.
- **Timezone/date semantics:** store `startDate`/`endDate` as timestamps (UTC); term-window validation compares timestamps to avoid off-by-one at TZ boundaries (same rule as PRP-15's `trialEndsAt`).
- **Archival vs. delete:** years that carry enrollment/marks must never be hard-deleted (FK cascades would erase history, breaking D23). `archiveAcademicYear` is the only retirement path; deletion is allowed only for an empty year (guard in the service).
- Rollback: the module is additive and inert until routes are registered; revert the module + drop the two tables (additive migration).
