# PRP-45 — Student fee adjustments + configurable late fines

> **Status:** Proposed · **Phase:** 4 · **Severity:** 🔴 High · **Size:** L
> **Depends on:** PRP-44 (`FeeHead`/`FeePlan`/`FeePlanItem` + `resolvePublishedPlan` — adjustments and fines modify the dues a published plan produces), PRP-32 (`Enrollment` — an adjustment targets a student enrolled in a class/year; sibling/optional-head logic reads enrollment), PRP-31 (`Student` + guardian/sibling linkage — sibling concessions), PRP-28 (academic year scoping), PRP-17 (`fees.*` permissions, defined in PRP-44), PRP-12 (school context), PRP-15 (`requireWritableSchool`), PRP-18 (`writeAudit`) · **Feeds:** PRP-46 (the dues computation + payment settlement applies adjustments and accrues fines), PRP-47 (FE adjustments UI)

## 1. Problem / current state
PRP-44 gives every student in a class the *same* published plan. Real schools never bill flat: decision **D21** requires **student-level adjustments** (discounts / scholarships / concessions — sibling, staff-ward, merit), **optional heads** opted-in per student (e.g. transport-by-route), and **configurable late fines** when an installment is paid past its due date. Without this layer, a sibling discount or a transport opt-in has nowhere to live, and a school cannot levy a late fee.

PRP-44 established `src/modules/fees/` and the `resolvePublishedPlan` contract. This PRP extends that module with two concerns: **adjustments** (per-student deltas against a published plan) and **fines** (a per-school rule + accrued fine records). Neither materializes a dues ledger or takes money — PRP-46 owns settlement; this PRP defines the inputs PRP-46's dues calculation reads.

> ⚠︎ **Open question (master §10 O-P4 — fine calculation rules):** the exact fine model (flat per overdue installment vs. per-day vs. percentage; grace days; cap) is **not finalized**. This PRP models a **configurable `FineRule`** (`FLAT` | `PER_DAY` | `PERCENT`, with `graceDays` and an optional `maxAmount` cap) so any policy is data, not code. The default seed is a single flat fine per overdue installment; treat the parameters as adjustable. The *accrual* (turning a rule + overdue installment into a `Fine` row) is specified here but **invoked by PRP-46** at dues-computation/payment time (it needs the payment/ledger context) — see §3.4.

## 2. Goal & non-goals
- **Goal:** `FeeAdjustment` (a per-student, per-year delta — a discount/concession on a head or whole plan, *or* an optional-head opt-in that *adds* a charge), `FineRule` (per-school configurable late-fine policy, optionally per-head), and `Fine` (an accrued late-fee instance against a student + installment). Plus the service surface to manage adjustments + the fine rule, and a pure **`computeStudentDues(fastify, { studentId, academicYearId })`** helper that folds plan + adjustments + accrued fines into a per-student dues breakdown — the single calculation **PRP-46 imports** to know what a student owes. All money is Prisma **`Decimal`** (PRP-44 discipline).
- **Non-goals:** the payment records / `Payment`, receipts, the persisted dues ledger and defaulter reports (PRP-46), the FE screens (PRP-47), online payment (P7). **Refund handling is explicitly out of scope** (master §10 O-P4 ⚠︎ — flag where a negative/credit adjustment could later support it, but do not build refunds). Bulk-applying an adjustment to many students (e.g. "all staff wards") is a convenience deferred — v1 applies per student (note as additive in §8).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Same Decimal/year-scope discipline as PRP-44; enums from `src/generated/prisma/enums.js`.

```prisma
enum AdjustmentKind {
  DISCOUNT        // reduces dues: sibling / staff-ward / merit / scholarship / concession (D21)
  OPTIONAL_HEAD   // adds an optional head's charge for this student (e.g. transport-by-route)
}

enum AdjustmentValueType {
  AMOUNT          // fixed ₹ off / on
  PERCENT         // % of the targeted head (or whole plan) — resolved to Decimal at compute time
}

enum FineRuleType {
  FLAT            // one fixed amount per overdue installment
  PER_DAY         // amount × days overdue (past graceDays)
  PERCENT         // % of the overdue installment amount
}

model FeeAdjustment {
  feeAdjustmentId String              @id @default(uuid())
  schoolId        String
  academicYearId  String                                  // year-scoped (D18) — adjustments don't bleed across years
  studentId       String
  kind            AdjustmentKind
  feeHeadId       String?                                 // null = applies to the whole plan (DISCOUNT only)
  valueType       AdjustmentValueType
  amount          Decimal             @db.Decimal(12, 2)   // ₹ for AMOUNT; for PERCENT this holds the percentage (e.g. 25.00)
  reason          String?                                 // "Sibling", "Staff ward", "Merit scholarship"
  isActive        Boolean             @default(true)
  student         Student             @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  feeHead         FeeHead?            @relation(fields: [feeHeadId], references: [feeHeadId])
  school          School              @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([schoolId])
  @@index([studentId, academicYearId])
  @@index([feeHeadId])
}

model FineRule {
  fineRuleId  String       @id @default(uuid())
  schoolId    String
  name        String                                    // "Standard late fee"
  type        FineRuleType @default(FLAT)
  amount      Decimal      @db.Decimal(12, 2)            // ₹ (FLAT/PER_DAY) or % (PERCENT)
  graceDays   Int          @default(0)                  // days after dueDate before a fine accrues (O-P4 ⚠︎)
  maxAmount   Decimal?     @db.Decimal(12, 2)           // optional cap (PER_DAY/PERCENT)
  feeHeadId   String?                                   // null = applies to any overdue installment; set = head-specific
  isActive    Boolean      @default(true)
  fines       Fine[]
  school      School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  @@index([schoolId])
}

model Fine {
  fineId         String    @id @default(uuid())
  schoolId       String
  academicYearId String
  studentId      String
  fineRuleId     String
  feePlanItemId  String?                                 // the overdue installment this fine is for (PRP-44)
  amount         Decimal   @db.Decimal(12, 2)            // accrued ₹ — Decimal, never float
  reason         String?                                 // "Overdue: Term 1 tuition"
  waivedAt       DateTime?                               // an admin may waive a fine (audited) — not a refund
  fineRule       FineRule  @relation(fields: [fineRuleId], references: [fineRuleId])
  student        Student   @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school         School    @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([studentId, feePlanItemId, fineRuleId], name: "uniq_fine_accrual")  // accrual key — makes accrueFinesForStudent's upsert race-safe (§3.3)
  @@index([schoolId])
  @@index([studentId, academicYearId])
  @@index([feePlanItemId])
}
```
The `@@unique([studentId, feePlanItemId, fineRuleId])` is the **accrual key**: it is exactly the (student, installment, rule) tuple `accrueFinesForStudent` upserts on (§3.3), so two concurrent accrual runs (lazy-on-view + a job) can't insert two fines for the same overdue installment — the DB constraint backstops the upsert against the race, mirroring PRP-46's receipt-counter `@@unique` discipline. (⚠︎ NULL note: `feePlanItemId` is nullable; Postgres treats NULLs as distinct, so a fine **not** tied to a specific installment is not de-duplicated by this constraint — in practice accrual always sets `feePlanItemId` to the overdue installment, so the key is non-null on the accrual path.)
Add back-relations to `School` (`feeAdjustments`, `fineRules`, `fines`), to `FeeHead` (`adjustments FeeAdjustment[]`, `fineRules FineRule[]` — coordinate with PRP-44's `FeeHead`, see §8), and to `Student` (`feeAdjustments FeeAdjustment[]`, `fines Fine[]` — coordinate with PRP-31/29/46 which also extend `Student`, §8). `Fine.feePlanItemId` is a loose reference (no FK block) to keep it decoupled from PRP-44's item rows.

> **Decision — adjustments are *deltas*, dues are *computed* (not stored here):** a `FeeAdjustment` never rewrites a `FeePlanItem` (PRP-44 plans are immutable). It is a signed modifier resolved at **compute** time: `DISCOUNT` subtracts, `OPTIONAL_HEAD` adds. This keeps the published plan canonical and shared, and the per-student variance isolated — exactly the D21/D22 model (history is the year-scoped plan + the student's adjustment rows). The materialized per-student dues *ledger* (`StudentFee`) is PRP-46's, fed by the helper below.

### 3.2 The dues calculation — `computeStudentDues` (the P4 contract)
A pure, well-tested function in `fee-adjustments.service.ts` (or a co-located `fees.calc.ts`), exported for PRP-46:

```
computeStudentDues(fastify, { schoolId, studentId, academicYearId, asOf? }) → {
  planVersion,
  lines: Array<{ feeHeadId, label, baseAmount, adjustments: Decimal, fineAmount: Decimal, netDue: Decimal, termId?, dueDate?, status }>,
  totals: { gross: Decimal, discounts: Decimal, optionalAdds: Decimal, fines: Decimal, netDue: Decimal },
}
```
Algorithm (all `Decimal`):
1. Resolve the student's enrolled grade for the year (PRP-32 `Enrollment`) → `resolvePublishedPlan(schoolId, gradeId, academicYearId)` (PRP-44). Throw `412` if no plan or no enrollment.
2. Start from the plan's `FeePlanItem`s (only `isOptional: false` heads are billed automatically; optional heads appear **only** if an `OPTIONAL_HEAD` adjustment opted the student in).
3. Apply `DISCOUNT` adjustments (head-targeted first, then whole-plan), resolving `PERCENT` to `Decimal` of the relevant base; clamp net ≥ 0.
4. Fold accrued `Fine` rows (non-waived) for the student/year onto the relevant installment line.
5. Sum into `totals`; serialize all `Decimal`s as **strings**.

This function does **not** read payments — it returns the *charge* side. PRP-46 subtracts recorded payments to get the *outstanding* balance. Keeping the split clean means this helper is unit-testable in isolation (a stated acceptance criterion).

### 3.3 Services & routes (extend `src/modules/fees/`)
Add to the module PRP-44 created (same folder/conventions): `fee-adjustments.{routes,controller,service,schema,types}.ts`. All `fastify`-first, tenant-scoped via `request.schoolContext.schoolId`.
- **Adjustments:** `createAdjustment(fastify, schoolId, { studentId, academicYearId, kind, feeHeadId?, valueType, amount, reason })` — validates the student is enrolled that year (PRP-32), and that an `OPTIONAL_HEAD` adjustment references an `isOptional` head; `listAdjustments(studentId, academicYearId)` / `deactivateAdjustment(feeAdjustmentId)` (soft — no hard delete, history). Audited.

> **Decision — mid-year change contract is *deactivate-then-create* (no `updateAdjustment`):** an adjustment is **immutable once created**; changing a concession/optional-head mid-year (e.g. a route-fare or room-fare change) is done by **`deactivateAdjustment(oldId)` then `createAdjustment(...)` with the new amount**, never by mutating the existing row in place. This keeps an auditable, year-scoped history of what was billed when (consistent with the soft-delete discipline above and the "adjustments are deltas, plans immutable" model), and avoids a silent rewrite of an already-billed line. **This module deliberately exports only `createAdjustment` + `deactivateAdjustment`; there is no `updateAdjustment` verb.** Downstream PRPs that change an optional-head amount mid-year (PRP-64 transport route-fare, PRP-68 hostel/mess room-fare) **must** reference this deactivate-then-create pair — it is the real, exported contract.
- **Fine rule:** `setFineRule` / `listFineRules` / `deactivateFineRule` — per-school config (O-P4 ⚠︎ shape). Audited (`fine_rule.update`).
- **Fine accrual + waive:** `accrueFinesForStudent(fastify, tx, { schoolId, studentId, academicYearId, asOf })` — for each overdue, unpaid installment past `dueDate + graceDays`, create/refresh a `Fine` per the active `FineRule` (idempotent per (student, installment, rule) — upsert so re-running doesn't double-charge). **Composable (`tx` arg) and invoked by PRP-46** during dues computation / payment recording. `waiveFine(fastify, schoolId, fineId)` — sets `waivedAt`; audited (`fine.waive`) — explicitly **not** a refund.
- **Exported calc:** `computeStudentDues` (§3.2).

Routes (school-scoped subtree, `requirePermission` PRP-17, mutations also `requireWritableSchool` PRP-15):
- `POST|GET /api/school/students/:studentId/fee-adjustments` (list takes `?academicYearId=`) — (`fees.manage` / `fees.read`)
- `DELETE /api/school/fee-adjustments/:feeAdjustmentId` (deactivate) — (`fees.manage`)
- `PUT|GET /api/school/fine-rules` — (`fees.manage` / `fees.read`)
- `POST /api/school/fines/:fineId/waive` — (`fees.manage`)
- `GET /api/school/students/:studentId/dues?academicYearId=` — (`fees.read`) — returns `computeStudentDues` (also consumed by PRP-46's parent/admin views)

All responses use `successResponse`/`errorResponse`.

### 3.4 Permission strings
Reuses PRP-44's `fees.read` / `fees.manage` (no new resource). Adjustments + fine config are `fees.manage`; viewing dues/adjustments is `fees.read`. (Fine *accrual* is internal — invoked by PRP-46 inside a `fees.collect` payment flow or a job, not a directly-permissioned route.)

## 4. Implementation steps
1. **Schema:** add `AdjustmentKind`, `AdjustmentValueType`, `FineRuleType`, the three models + the `School`/`FeeHead`/`Student` back-relations to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name fee_adjustments_and_fines` then `pnpm prisma:generate`. Coordinate the `FeeHead`/`Student` relation edits with PRP-44/31 (§8).
2. **Module:** add `fee-adjustments.{routes,controller,service,schema,types}.ts` to `src/modules/fees/`. Controllers thin; service `fastify`-first; enums/types from `src/generated/prisma/`.
3. **Calc helper:** implement `computeStudentDues` (§3.2) as a pure, unit-testable function using `Decimal` arithmetic and `resolvePublishedPlan` (PRP-44) + the student's `Enrollment` (PRP-32). Export it for PRP-46.
4. **Fine accrual:** implement `accrueFinesForStudent(tx)` as idempotent upserts keyed on (student, installment, rule); export composably for PRP-46.
5. **Routing:** register the new routes under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on writes.
6. **Audit:** `writeAudit()` (PRP-18) on `createAdjustment`, `setFineRule`, `waiveFine` (the money-affecting actions; D22 lists fee edits as auditable).
7. **Money:** all amounts via Prisma `Decimal` (PRP-44 import path); accept/return as strings.
8. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + `CreateAdjustmentBody`, `SetFineRuleBody`, `StudentDuesResponse` in `fee-adjustments.types.ts`.

## 5. Files added / changed
- **Add:** `src/modules/fees/fee-adjustments.routes.ts`, `fee-adjustments.controller.ts`, `fee-adjustments.service.ts` (+ optional `fees.calc.ts`), `fee-adjustments.schema.ts`, `fee-adjustments.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (no new strings — reuse `fees.*` from PRP-44; edit only if matrix annotations need updating)

## 6. Acceptance criteria
- [ ] `FeeAdjustment`/`FineRule`/`Fine` tables exist with the documented indexes; all carry `schoolId`; adjustments + fines are year-scoped; **all money columns are `Decimal`**.
- [ ] An Admin can record a `DISCOUNT` (sibling/staff/merit — amount or percent, head-targeted or whole-plan) and an `OPTIONAL_HEAD` opt-in (transport) for a student; the latter is rejected if the head is not `isOptional`.
- [ ] `computeStudentDues` returns a correct per-line breakdown — base from the published plan, discounts subtracted (net clamped ≥ 0), optional heads added only when opted in, fines folded in — with `Decimal` math and string-serialized totals; it is covered by **unit tests** (sibling %, staff flat, transport add, fine accrual).
- [ ] A configurable `FineRule` exists; `accrueFinesForStudent` creates exactly one fine per overdue installment past `dueDate + graceDays`, is idempotent on re-run, and respects `maxAmount`. The `Fine` `@@unique([studentId, feePlanItemId, fineRuleId])` makes the upsert **race-safe** (concurrent accrual runs can't double-insert — proven by a re-run/concurrent test).
- [ ] `waiveFine` zeroes a fine's effect via `waivedAt` (not a delete) and is audited; it is documented as **not** a refund.
- [ ] All routes are tenant-scoped + permission-guarded; mutations `403/402` on a non-writable school (PRP-15); adjustments/fine-rule/waive changes are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name fee_adjustments_and_fines` applies cleanly.
- Manual (against PRP-44 published plan + PRP-32 enrollment): add a 25% sibling discount + a transport opt-in to a student → `GET /students/:id/dues` reflects both; backdate an installment due date and run accrual → a `Fine` appears; waive it → dues drop; confirm a non-writable school `403/402`s a new adjustment.

## 8. Risks & rollback
- **Decimal correctness:** percentages and fines are the easiest place to leak floats — resolve `PERCENT` and `PER_DAY` to `Decimal` and round at 2dp deterministically; never `Number()` a rupee value (D1, PRP-15/44).
- **Calc/settlement split:** `computeStudentDues` returns *charges only*; PRP-46 owns *payments → outstanding*. Keeping the boundary clean is what makes the calc unit-testable and what PRP-46 depends on — do not let payment knowledge leak into this helper.
- **Fine accrual idempotency:** double-running accrual (lazy on view + a job) must not double-charge — the upsert key (student, installment, rule) is the guard, **backed by the `Fine` `@@unique([studentId, feePlanItemId, fineRuleId])`** so even a concurrent race can't double-insert (catch `P2002` → treat as already-accrued); cover with a re-run test. Ownership of *when* accrual runs is PRP-46's (it has the payment context); this PRP only provides the composable function.
- **Shared `Student`/`FeeHead` edits:** this PRP adds relations to `Student` (also touched by PRP-31/29/46) and `FeeHead` (PRP-44). Whichever lands first adds the relation block; review the others' migrations for a clean rebase (call out in the PR), exactly as PRP-29 §8 notes for `Student`.
- **Refunds (O-P4 ⚠︎):** explicitly out of scope; a credit could later be a negative/credit `FeeAdjustment` or a `Refund` model in P7 — note the seam, build nothing.
- Rollback: additive module + tables; revert the module, drop the three tables, remove the back-relations (coordinate with PRP-44/31).
