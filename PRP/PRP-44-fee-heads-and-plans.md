# PRP-44 — Fee heads + per-class, year-versioned fee plans

> **Status:** Proposed · **Phase:** 4 · **Severity:** 🔴 High · **Size:** L
> **Depends on:** PRP-28 (academic year + terms — plans are year-scoped and installments align to `Term`s), PRP-29 (`Grade`/`Stream` — a plan targets a class), PRP-17 (RBAC — owns the new `fees.*` permission strings), PRP-12 (school context / tenant scoping), PRP-15 (`requireWritableSchool` — fee config is a write), PRP-18 (`writeAudit` on plan publish/version) · **Feeds:** PRP-45 (adjustments + fines reference `FeeHead`/`FeePlan`/`FeePlanItem`), PRP-46 (payments settle the dues a published plan produces), PRP-47 (FE fee-setup UI)

## 1. Problem / current state
The platform has **no fee model whatsoever**. The schema (`prisma/schema.prisma`) covers tenancy/identity (`School`, `UserSchool`, profile tables, `Student`, `ParentStudent`) and — once PRP-28/29 land — the academic backbone (`AcademicYear`, `Term`, `Grade`, `Section`, `Stream`), but nothing models what a school *charges*. Decision **D21** is explicit: a **per-class fee plan per year** (heads + installments aligned to terms + due dates) that is **year-versioned** so history is preserved (D22: "fee history comes for free from year-scoped plans"). This PRP builds the configuration layer — the catalog of charges and the per-class plan — that PRP-45 (student adjustments + fines) and PRP-46 (manual payments + receipts) consume.

There is no school-scoped fee module under `src/modules/`; PRP-28 established the first school-scoped module (`src/modules/academic/`) and the pattern (`requireSchoolContext` + `requirePermission` + `requireWritableSchool`, `fastify`-first services, `successEnvelope` schemas). This PRP adds `src/modules/fees/` following that pattern exactly.

> ⚠︎ **Open question (master §10 O-P4 — fee-head taxonomy):** the exact set of fee heads (Tuition / Admission / Exam / Transport / Lab / Library / Misc…) and whether some are one-time vs. recurring is **not finalized**. This PRP models a **school-defined `FeeHead` catalog** (no hardcoded enum) with a `frequency` discriminator (`ONE_TIME` | `RECURRING`) so any taxonomy is data, not code. Treat the seed list as illustrative.

## 2. Goal & non-goals
- **Goal:** three models — `FeeHead` (per-school catalog of charge types), `FeePlan` (a `Grade` × `AcademicYear` × **`version`** plan, with a `status` of `DRAFT`/`PUBLISHED`/`ARCHIVED`), and `FeePlanItem` (one line per head with a `Decimal` amount, an optional `Term` installment, and a due date) — plus a `src/modules/fees/` module with admin CRUD, a **publish + version** transition, and a `resolvePublishedPlan(fastify, schoolId, gradeId, academicYearId)` helper the rest of P4 imports. All money is Prisma **`Decimal`**, never float.
- **Non-goals:** student-level adjustments/discounts and late fines (PRP-45 — this PRP exposes the plan they layer on), the per-student dues ledger / `StudentFee` materialization and payments (PRP-46 owns settlement), receipt PDFs (PRP-46 + the cross-cutting PDF service), the FE screens (PRP-47), online payment (P7, OUT of scope per D7). Refund handling is out of scope here (PRP-46 ⚠︎).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Mirror the Decimal/money discipline from **PRP-15** (`@db.Decimal`) and the year-version idiom from PRP-28 (everything carries `schoolId` + `academicYearId`). Import the new enums from `src/generated/prisma/enums.js`.

```prisma
enum FeeHeadFrequency {
  ONE_TIME      // admission, registration — charged once
  RECURRING     // tuition, transport — charged per installment/term
}

enum FeePlanStatus {
  DRAFT         // editable; not yet billable
  PUBLISHED     // immutable; produces student dues (PRP-46)
  ARCHIVED      // superseded by a newer version, or year rolled over
}

model FeeHead {
  feeHeadId   String           @id @default(uuid())
  schoolId    String
  name        String                                   // "Tuition", "Transport", "Exam" — school-defined (O-P4 ⚠︎)
  code        String?                                  // optional short code "TUIT"
  frequency   FeeHeadFrequency @default(RECURRING)
  isOptional  Boolean          @default(false)         // optional heads (e.g. transport) opted-in per student via PRP-45
  isActive    Boolean          @default(true)
  description String?
  planItems   FeePlanItem[]
  school      School           @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
}

model FeePlan {
  feePlanId      String        @id @default(uuid())
  schoolId       String
  academicYearId String                                // year-scoped (D18/PRP-28) — history via year (D22)
  gradeId        String                                // per-class plan (D21); one plan per grade per year-version
  version        Int           @default(1)             // year-versioned (D21) — bump on republish
  status         FeePlanStatus @default(DRAFT)
  name           String?                               // optional label, e.g. "Class 1 — 2026-27"
  publishedAt    DateTime?
  items          FeePlanItem[]
  school         School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  // Exactly one PUBLISHED plan per (school, year, grade) — enforced in service (§3.3), not a DB partial-unique.
  @@unique([schoolId, academicYearId, gradeId, version])
  @@index([schoolId])
  @@index([academicYearId, gradeId])
  @@index([status])
}

model FeePlanItem {
  feePlanItemId String   @id @default(uuid())
  schoolId      String                                 // denormalized for tenant scoping (house convention)
  feePlanId     String
  feeHeadId     String
  amount        Decimal  @db.Decimal(12, 2)            // ₹ — Prisma Decimal, NEVER float (D1, like PRP-15)
  termId        String?                                // installment alignment (D21/D18); null = whole-year / one-time
  installmentNo Int?                                   // 1-based within the year for RECURRING heads (alt. to termId)
  dueDate       DateTime?                              // when this installment is due (drives defaulter calc, PRP-46)
  feePlan       FeePlan  @relation(fields: [feePlanId], references: [feePlanId], onDelete: Cascade)
  feeHead       FeeHead  @relation(fields: [feeHeadId], references: [feeHeadId])
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([schoolId])
  @@index([feePlanId])
  @@index([termId])
}
```
Add back-relations to `School`: `feeHeads FeeHead[]`, `feePlans FeePlan[]` (mirrors the existing `students Student[]`). The `FeePlanItem → Term` link is by `termId` only (no FK relation block, to avoid coupling the migration to PRP-28's `Term`; the service validates the `termId` belongs to the plan's year) — note this in §8.

> **Decision — year-versioned plans, not edited-in-place (D21/D22):** once a `FeePlan` is `PUBLISHED` it is **immutable**. A correction creates a **new version** (`version + 1`, status `DRAFT` → `PUBLISHED`) and `ARCHIVED`s the prior published one; the old version's items survive untouched, so any receipt/ledger that referenced it stays reproducible. This is the same "history via versioning" pattern PRP-28 uses for years and is *why* D22 says fee history is "free" — we never overwrite a published amount. "Exactly one PUBLISHED version per (school, year, grade)" is enforced in the publish transaction (§3.3), not a DB constraint (Postgres has no clean partial-unique on a status — same call PRP-28 makes for `isCurrent`).

### 3.2 Money handling (mirror PRP-15)
- Every monetary column is `Decimal @db.Decimal(12, 2)` (₹, 2dp). **Never** `Float`/`Number` for money (PRP-15 §8 risk; D1).
- Service inputs accept amounts as **strings** (JSON has no decimal type); the service constructs Prisma `Decimal` from the string. The Prisma `Decimal` runtime is reachable via the generated client (Prisma re-exports `Decimal`); follow whatever PRP-15's subscription service settled on for the import path (it introduced the first `Decimal` columns) and reuse it — do not introduce a second pattern.
- Sums (plan totals, surfaced to FE) are computed with `Decimal` arithmetic and serialized as strings in the response, so the FE never does float math (PRP-47 displays them verbatim).

### 3.3 Services & routes (`src/modules/fees/`)
Follow the house split (`fee-config.routes.ts` / `.controller.ts` / `.service.ts` / `.schema.ts` / `.types.ts`); controllers thin; service `fastify`-first; all reads/writes scoped by `request.schoolContext.schoolId` (PRP-12 — **never** a client-supplied `schoolId`). `fee-config.service.ts` exports:

- **Heads:** `createFeeHead` / `listFeeHeads` / `updateFeeHead` (toggle `isActive`/`isOptional`/`frequency`). A head referenced by any plan item cannot be hard-deleted — deactivate instead (guard with `fastify.httpErrors.conflict`).
- **Plans (draft):** `createFeePlan(fastify, schoolId, { academicYearId, gradeId })` — opens a `DRAFT` at the next `version` for that (year, grade); `setFeePlanItems(fastify, schoolId, feePlanId, items[])` — full-replace of the draft's items (each `{ feeHeadId, amount, termId?, installmentNo?, dueDate? }`), validating: plan is `DRAFT`, every `feeHeadId` is an active head of this school, every `termId` (if given) belongs to the plan's `academicYearId` (call PRP-28's term lookup), amounts parse to non-negative `Decimal`.
- **Publish + version:** `publishFeePlan(fastify, schoolId, feePlanId)` — transaction: require `DRAFT` with ≥1 item, set `status: PUBLISHED` + `publishedAt`, and `ARCHIVED` any previously-`PUBLISHED` plan for the same (year, grade). Audited (`writeAudit`, PRP-18, `action: 'fee_plan.publish'`, metadata `{ gradeId, academicYearId, version }`). **Republish flow:** `createFeePlan` again → new `DRAFT` at `version + 1` (optionally cloning the prior version's items as a starting point) → edit → publish → prior version auto-archived.
- **Resolution helper (exported for P4):** `resolvePublishedPlan(fastify, schoolId, gradeId, academicYearId) → FeePlan & { items }` — returns the single `PUBLISHED` plan (newest version) for that class+year; throws `fastify.httpErrors.preconditionFailed('No published fee plan for this class/year')` if none. **PRP-45 and PRP-46 import this** via `'../fees/fee-config.service.js'` — it is the contract by which dues are computed. Also `listFeePlans(academicYearId?)` / `getFeePlan(feePlanId)` (with items + computed `Decimal` total).

Routes (school-scoped subtree under `src/plugins/school.plugin.ts`, each `requirePermission` (PRP-17) + mutations also `fastify.requireWritableSchool` (PRP-15)):
- `POST|GET /api/school/fee-heads`, `PATCH /api/school/fee-heads/:feeHeadId` — (`fees.manage` / `fees.read`)
- `POST|GET /api/school/fee-plans` (list takes `?academicYearId=`) — (`fees.manage` / `fees.read`)
- `GET /api/school/fee-plans/:feePlanId` — (`fees.read`)
- `PUT /api/school/fee-plans/:feePlanId/items` — (`fees.manage`)
- `POST /api/school/fee-plans/:feePlanId/publish` — (`fees.manage`)

All responses use `successResponse`/`errorResponse` (`src/utils/api-response.ts`).

### 3.4 Permission strings (extends PRP-17 §3.4)
Introduce the **`fees`** resource (PRP-17 owns the canonical list + seed matrix in `src/modules/authz/permissions.ts`; this PRP adds the rows). PRP-45/46 reuse the same resource (no new resource per PRP).

| Resource | Actions (P4) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `fees` | `read`, `manage`, `collect` | read+manage+collect | read+collect | – | – | `read` (own children — PRP-46) |

`fees.manage` = configure heads/plans/adjustments (this PRP + PRP-45); `fees.collect` = record payments/issue receipts (PRP-46); `fees.read` = view dues/reports. (Parent read-scope is the multi-child view in PRP-46/PRP-41.)

## 4. Implementation steps
1. **Schema:** add `FeeHeadFrequency`, `FeePlanStatus`, the three models + the two `School` back-relations to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name fee_heads_and_plans` then `pnpm prisma:generate`. Confirm `Decimal` columns generate correctly.
2. **Module scaffold:** add `src/modules/fees/fee-config.{routes,controller,service,schema,types}.ts` following the module split (controllers thin; service `fastify`-first). Import enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Services:** implement §3.3, especially the `publishFeePlan` transaction (publish + auto-archive prior version) and the exported `resolvePublishedPlan` helper. Reuse PRP-28's term lookup to validate `termId` belongs to the plan's year. Use `fastify.httpErrors.*` for all error paths; map any `P2002` (e.g. duplicate head name) the way `developer.service.ts` does.
4. **Money:** parse amount strings → Prisma `Decimal`; reuse PRP-15's `Decimal` import path; compute plan totals with `Decimal`, serialize as strings.
5. **Routing:** register `fee-config.routes.ts` under `src/plugins/school.plugin.ts`; guard with `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on writes.
6. **Permissions:** add the `fees.read`/`fees.manage`/`fees.collect` rows + matrix entries to `src/modules/authz/permissions.ts` (PRP-17) and re-run `pnpm seed:permissions`.
7. **Audit:** call `writeAudit()` (PRP-18) on `publishFeePlan` (the version-bearing critical action) and on `createFeeHead`/`updateFeeHead`.
8. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style from `src/modules/developer/developer.schema.ts`) + `CreateFeeHeadBody`, `SetFeePlanItemsBody`, `FeePlanListItem` etc. in `fee-config.types.ts`.

## 5. Files added / changed
- **Add:** `src/modules/fees/fee-config.routes.ts`, `fee-config.controller.ts`, `fee-config.service.ts`, `fee-config.schema.ts`, `fee-config.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `fees.*`)

## 6. Acceptance criteria
- [ ] `FeeHead`/`FeePlan`/`FeePlanItem` tables exist with the documented unique constraints + indexes; all carry `schoolId`; plans + items are year-scoped; **all money columns are `Decimal`** (no `Float`).
- [ ] An Admin can create fee heads (school-defined), create a `DRAFT` plan for a class+year, set its items (head/amount/term-installment/due), and publish it.
- [ ] Publishing sets `PUBLISHED` and **auto-archives** any prior published version for the same (year, grade); a second publish creates `version 2` and the old version's items remain unchanged (history preserved — D22).
- [ ] `resolvePublishedPlan` returns the newest `PUBLISHED` plan for a class+year and throws `412` when none exists.
- [ ] A `termId` that does not belong to the plan's academic year is rejected (`400`); a negative amount is rejected.
- [ ] All routes are tenant-scoped (client-supplied `schoolId` ignored) + permission-guarded; mutations `403/402` on a non-writable school (PRP-15).
- [ ] Plan publish is audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name fee_heads_and_plans` applies cleanly; `pnpm seed:permissions` adds `fees.*`.
- Manual: create heads (Tuition recurring, Admission one-time, Transport optional) → create a Class 1 / 2026-27 draft → add items with term installments + due dates → publish → `resolvePublishedPlan` returns it; create a v2 draft, publish, confirm v1 is `ARCHIVED` and still readable.

## 8. Risks & rollback
- **Decimal handling (paramount):** money is `Decimal @db.Decimal(12,2)` end-to-end; never float (D1, PRP-15 §8). Accept/return amounts as strings across the API so no JS float ever touches a rupee value.
- **Single-published invariant is service-enforced:** "one PUBLISHED version per (year, grade)" lives in the `publishFeePlan` transaction, not the DB — that transaction is the only writer of `status: PUBLISHED`; never flip status via raw updates elsewhere. Cover with a two-version test.
- **Immutability of published plans:** PRP-46's dues/receipts assume a published plan never changes — enforce immutability hard (reject `setFeePlanItems` on a non-`DRAFT` plan). Corrections go through versioning, not edits.
- **`Term` coupling (PRP-28):** `FeePlanItem.termId` is a loose reference (no FK block) validated in the service; if PRP-28's `Term` shape changes, only the validation query moves. Coordinate the migration ordering — land PRP-28 first (it is a declared dependency).
- **Taxonomy churn (O-P4 ⚠︎):** heads are data, not an enum, so a taxonomy change is a seed/data edit, not a migration — this is the deliberate hedge against the unresolved open question.
- Rollback: the module is additive and inert until routes are registered; revert the module + drop the three tables (additive migration) + remove the `School` back-relations.
