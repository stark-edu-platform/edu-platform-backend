# PRP-32 — Enrollment + bulk promotion + TC/alumni

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P2-BE-32 (implementation-plan §P2, master-prp §5.7/§6, decision D23) · **Depends on:** PRP-28 (`AcademicYear`/`Term`, `resolveCurrentAcademicYear`, `archiveAcademicYear`), PRP-29 (`Section`/`Grade`/`ClassSubject`/`StudentSubject`, `deriveStudentSubjects`), PRP-31 (`Student`, `StudentStatus`, `setStudentStatus`) · **Feeds:** PRP-33 (admissions converts to `Student` + `Enrollment`), PRP-34 (import can seed enrollments), P3 attendance / P4 fees / P5 exams (all read the per-year `Enrollment` for section placement + billable seats)

## 1. Problem / current state
A `Student` is a year-agnostic identity (PRP-31), and the academic structure (`Grade`/`Section`, PRP-29) exists per year — but **nothing places a student into a section for a given year**, and there is **no year-end lifecycle**. Decision **D23** requires: **per-year enrollment records**; year-end **bulk promotion** (promote / detain / graduate→alumni); mid-year **transfer in/out with a TC** (transfer certificate); and a **full historical academic trail** per student. This is also what makes the subscription **seat count** (PRP-15 `recomputeSeatCount`, per-student billing D2) computable — billable students = active enrollments in the current year.

Without `Enrollment`, attendance (P3), fees (P4) and exams (P5) have nothing to scope to (they all need "which section is this student in *this* year?"), and year-on-year rollover (PRP-28's archival) has no driver. This PRP is the lifecycle engine D23 describes.

## 2. Goal & non-goals
- **Goal:** an `Enrollment` (student × section × year, with status) model; a `TransferCertificate` model; enrollment CRUD; a **bulk-promotion** engine (promote/detain/graduate across a year boundary) that also seeds the next year's `StudentSubject` rosters; transfer-in / transfer-out (with TC) flows; alumni status; a `recomputeSeatCount` hook into PRP-15.
- **Non-goals:** the year/term + section models themselves (PRP-28/29), the student identity (PRP-31), admissions intake (PRP-33 — it *calls* `enrollStudent`), the TC **PDF document** (P8/PRP-66 owns certificate PDF generation; this PRP records the TC *data* + number), the FE promotion UI (PRP-37). ⚠︎ promotion **policy** (auto-promote rules, detention criteria) is admin-driven per-student here; rule-based auto-promotion is out (see §3.4).

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```prisma
enum EnrollmentStatus {
  ENROLLED       // active in this year's section
  PROMOTED       // moved up (a new ENROLLED row exists for the next year)
  DETAINED       // repeats the grade (new ENROLLED row, same grade, next year)
  TRANSFERRED    // left mid/end-year via TC
  GRADUATED      // completed final grade → alumni
  WITHDRAWN
}

model Enrollment {
  enrollmentId   String           @id @default(uuid())
  schoolId       String
  academicYearId String                              // year-scoped (D18/PRP-28)
  studentId      String
  sectionId      String                              // → Section (PRP-29); carries grade/stream transitively
  rollNumber     String?                             // within-section roll, optional
  status         EnrollmentStatus @default(ENROLLED)
  enrolledAt     DateTime         @default(now())
  exitedAt       DateTime?                           // set on transfer/graduate/withdraw
  student        Student          @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school         School           @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  transferCertificate TransferCertificate?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt

  @@unique([academicYearId, studentId])             // one enrollment per student per year
  @@index([schoolId])
  @@index([academicYearId, sectionId])
  @@index([studentId])
  @@index([academicYearId, status])                 // seat-count + reporting
}

model TransferCertificate {
  tcId           String   @id @default(uuid())
  schoolId       String
  enrollmentId   String   @unique
  tcNumber       String                              // unique per school
  issueDate      DateTime @default(now())
  reason         String?
  remarks        String?
  fileKey        String?                             // generated PDF (PRP-66); null until generated
  enrollment     Enrollment @relation(fields: [enrollmentId], references: [enrollmentId], onDelete: Cascade)
  school         School     @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime   @default(now())

  @@unique([schoolId, tcNumber])
  @@index([schoolId])
}
```
Add `enrollments`, `transferCertificates` back-relations to `School`, and **`enrollments Enrollment[]` to the existing `Student`** (coordinate with PRP-29/PRP-31's `Student` edits — see §8). `Enrollment.sectionId` → PRP-29 `Section` (add the inverse relation there or keep a loose indexed FK; prefer explicit).

> **Decision — enrollment as the year-link + history trail (D23):** a student accumulates **one `Enrollment` per year**; the *sequence* of rows is the historical academic trail. Promotion never edits a past row — it sets the old row's `status` (PROMOTED/DETAINED/GRADUATED) and **inserts a new `ENROLLED` row** in the next year's section. Seat count (PRP-15) = `count(Enrollment where academicYearId = current AND status = ENROLLED)`. Mid-year transfer-out sets `status = TRANSFERRED` + `exitedAt` and creates a `TransferCertificate`; transfer-in creates a `Student` (PRP-31) + an `Enrollment` mid-year.

### 3.2 Module layout (`src/modules/enrollment/`)
- `enrollment.routes.ts` / `enrollment.controller.ts` / `enrollment.service.ts` / `enrollment.schema.ts` / `enrollment.types.ts`.
- Imports `resolveCurrentAcademicYear` + `archiveAcademicYear` (PRP-28), `deriveStudentSubjects` (PRP-29), `createStudent` + `setStudentStatus` (PRP-31).

### 3.3 Services & routes
`enrollment.service.ts` exports (`fastify`-first, tenant-scoped):
- **`enrollStudent(fastify, schoolId, { studentId, sectionId, academicYearId?, rollNumber? }, tx?)`** — creates an `ENROLLED` row (default year via `resolveCurrentAcademicYear`), enforces the one-per-year unique, and **calls `deriveStudentSubjects(tx, …)`** (PRP-29) so the student's compulsory subject roster for the year is seeded in the same transaction. Then `recomputeSeatCount` (PRP-15). Composable via `tx` for PRP-33/PRP-34.
- `listEnrollments(fastify, schoolId, { academicYearId?, sectionId?, status?, cursor?, limit? })`, `getEnrollment`, `updateEnrollment` (e.g. section change/roll number — re-derives roster if grade/stream changes), `withdrawEnrollment`.
- **`promoteCohort(fastify, schoolId, { fromAcademicYearId, toAcademicYearId, decisions: [{ studentId, action: PROMOTE|DETAIN|GRADUATE, toSectionId? }] })`** — the bulk engine, one transaction: for each decision, set the source `Enrollment.status`, and
  - **PROMOTE** → insert a new `ENROLLED` row in `toSectionId` (a section of the next `Grade.level`), derive its roster;
  - **DETAIN** → insert a new `ENROLLED` row in a same-grade section of the new year;
  - **GRADUATE** → set source `GRADUATED` + `Student.status = GRADUATED` (alumni; no new enrollment).
  Returns a per-student result summary. Idempotent guard: refuses if a target-year enrollment already exists for a student. Audited per cohort run (`action: 'enrollment.promote_cohort'`, count in metadata).
- **`transferOut(fastify, schoolId, { enrollmentId, reason, remarks, tcNumber? })`** — set `status = TRANSFERRED` + `exitedAt`, `Student.status = TRANSFERRED`, create the `TransferCertificate` (auto-number per school if `tcNumber` omitted). `transferIn` is `createStudent` (PRP-31) + `enrollStudent` mid-year (a thin convenience wrapper).
- `getStudentHistory(fastify, schoolId, studentId)` — the ordered enrollment trail (D23 historical view).
- `recomputeSeatCount(fastify, schoolId)` — thin call into PRP-15's `recomputeSeatCount` after enrollment count changes (keeps billing seats current; D2).

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations `requireWritableSchool` PRP-15):
- `POST /api/school/enrollments` (`enrollment.manage`) · `GET /api/school/enrollments` (`enrollment.read`) · `PATCH /api/school/enrollments/:enrollmentId` (`enrollment.manage`)
- `POST /api/school/enrollments/promote` (`enrollment.promote`) — the bulk run
- `POST /api/school/enrollments/:enrollmentId/transfer-out` (`enrollment.transfer`)
- `POST /api/school/enrollments/transfer-in` (`enrollment.transfer`)
- `GET /api/school/students/:studentId/enrollment-history` (`enrollment.read`)

> **Year rollover:** `promoteCohort` is the driver behind PRP-28's `archiveAcademicYear` — after a cohort is fully promoted into `toAcademicYearId` and that year is made current (PRP-28 `setCurrentAcademicYear`), the old year is archived. Archival is an explicit admin step (not auto), so a partially-promoted year is never archived.

### 3.4 Permission strings (extends PRP-17 §3.4)
| Resource | Actions (P2) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `enrollment` | `read`, `manage`, `promote`, `transfer` | all | read, manage, transfer | read | read (self) | read (children) |

(`promote` is the high-impact bulk action — ADMIN-only by matrix. STUDENT/PARENT reads are self/children-scoped in the service.) ⚠︎ rule-based auto-promotion (e.g. "promote all who passed") is **out**: decisions are an explicit per-student list the admin submits (UI may pre-fill from results in P5, but the engine takes explicit input).

## 4. Implementation steps
1. **Schema:** add `EnrollmentStatus`, `Enrollment`, `TransferCertificate` + `School` back-relations + `Student.enrollments`; coordinate the `Student` edit with PRP-29/PRP-31. `pnpm exec prisma migrate dev --name enrollment_and_promotion` then `pnpm prisma:generate`.
2. **Module:** add `src/modules/enrollment/{routes,controller,service,schema,types}.ts`; import the PRP-28/29/31 helpers listed in §3.2.
3. **Services:** implement `enrollStudent(…, tx?)` (composes `deriveStudentSubjects`), the `promoteCohort` transaction (the core engine), transfer-out/in + TC numbering, and the history read. Wire `recomputeSeatCount` (PRP-15) after count changes.
4. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; self/children scoping for STUDENT/PARENT reads.
5. **Audit:** `writeAudit()` (PRP-18) on enroll, `promote_cohort` (with counts), transfer-out (`enrollment.transfer_out`, TC number in metadata), withdraw.
6. **Schemas/types:** Fastify JSON schemas + request/response types; enums from `src/generated/prisma/enums.js`.

## 5. Files added / changed
- **Add:** `src/modules/enrollment/enrollment.routes.ts`, `enrollment.controller.ts`, `enrollment.service.ts`, `enrollment.schema.ts`, `enrollment.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts`, `src/modules/authz/permissions.ts` (PRP-17 — add `enrollment.*`), `src/modules/subscription/subscription.service.ts` (PRP-15 — `recomputeSeatCount` already exists; only wire the call if not yet exported)

## 6. Acceptance criteria
- [ ] `Enrollment` (one per student per year) + `TransferCertificate` tables exist with the documented constraints + indexes.
- [ ] `enrollStudent` places a student in a section for a year **and** seeds their compulsory `StudentSubject` roster (PRP-29) in the same transaction; rejects a second enrollment in the same year (`409`).
- [ ] `promoteCohort` processes a decision list: PROMOTE/DETAIN insert a new next-year `ENROLLED` row (roster re-derived), GRADUATE sets alumni status; past rows are never edited beyond their `status`.
- [ ] `transferOut` sets `TRANSFERRED` + `exitedAt`, marks the student `TRANSFERRED`, and creates a uniquely-numbered `TransferCertificate`.
- [ ] `getStudentHistory` returns the ordered enrollment trail (D23).
- [ ] Seat count recomputes after enrollment changes and matches `ENROLLED`-in-current-year (PRP-15/D2).
- [ ] STUDENT/PARENT reads are self/children-scoped; `promote` is ADMIN-only.
- [ ] Lifecycle actions are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name enrollment_and_promotion` applies cleanly.
- Manual: enroll a student → roster seeded + seat count up; run `promoteCohort` for a 2-student cohort (one PROMOTE, one GRADUATE) → next-year row + alumni; transfer-out a student → TC issued; fetch enrollment history → ordered trail.

## 8. Risks & rollback
- **Bulk-promotion correctness is the headline risk:** `promoteCohort` mutates many rows in one transaction. Make it **idempotent** (refuse if a target-year row exists), validate every `toSectionId` belongs to the next grade level, and run it inside `$transaction` so a partial failure rolls back entirely. Cover with a multi-student test (mixed PROMOTE/DETAIN/GRADUATE).
- **Shared `Student` edit:** adds `enrollments` to a `Student` model also edited by PRP-29/PRP-31 — land in order (28→29→31→32) and rebase the migration so the relation block accretes without duplicate fields.
- **Seat-count ↔ billing coupling:** seat count feeds per-student billing (D2/PRP-15). A miscount over/under-bills — recompute only from `ENROLLED`-in-current-year and call PRP-15's `recomputeSeatCount` after every enrollment-count-changing op (enroll/withdraw/transfer/promote).
- **TC numbering races:** auto-numbering must be collision-safe (the `@@unique([schoolId, tcNumber])` enforces it; generate inside the transaction and retry on `P2002`). The TC **PDF** is PRP-66 (P8) — this PRP only records the data.
- **Archival ordering (PRP-28):** never archive a year until its cohort is fully promoted into the next year; keep archival an explicit admin step.
- Rollback: additive module + tables; revert the module, drop the two tables, and remove `Student.enrollments` (coordinate with PRP-29/31 if all shipped).
