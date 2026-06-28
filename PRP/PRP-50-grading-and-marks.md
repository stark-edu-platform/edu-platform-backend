# PRP-50 — Configurable grading schemes & marks entry

> **Status:** Proposed · **Phase:** 5 · **Severity:** 🔴 High · **Size:** L
> **Depends on:** PRP-49 (`Exam`/`ExamSchedule` — marks are entered against a schedule's `maxMarks`/`passMarks`; `ExamType.isScholastic` distinguishes scholastic vs. co-scholastic), PRP-29 (`Subject`/`StudentSubject` — marks are **subject-aware per student**, D19; `Section` resolves who a teacher may mark), PRP-32 (`Enrollment` — only enrolled students get a marks row), PRP-30 (`TeacherAssignment` — a teacher may enter marks only for their assigned `Section`×`Subject`), PRP-28 (year/term scoping), PRP-12 (school context), PRP-17 (RBAC — new `marks.*` / `grading.*` strings), PRP-15 (`requireWritableSchool`), PRP-18 (audit on marks edits — a D22 critical action) · **Feeds:** PRP-51 (report cards aggregate `MarksEntry` and apply the `GradingScheme`), PRP-52 (FE teacher marks-entry grid), PRP-53 (FE result views)

## 1. Problem / current state
PRP-49 gives the platform exams and a per-subject timetable, but **no way to record what a student scored**, and **no grading model** that turns a raw mark into a CBSE-style grade (A1/B2…) or a co-scholastic descriptor (Grade A/B on a 3- or 5-point scale). Decision **D1** targets the **CBSE market** (CBSE-style report cards), and **D19** requires assessment to be **subject-aware** — a senior-secondary student is graded only on the subjects in their `StudentSubject` roster, which may differ from a classmate's in the same section. Master-prp §5.7 lists `GradingScheme` (**scholastic + co-scholastic bands**) and `MarksEntry` as the P5 entities; the implementation-plan row for PRP-50 carries the **⚠︎** flag pointing at **O-P5**.

**O-P5 (master §10) is the central open question here:** CBSE **scholastic grade bands** (the mark-range → letter-grade → grade-point mapping), **co-scholastic scales** (3-point / 5-point descriptive grades for Work Education, Art, Health, Discipline…), **grace marks**, **term weightage**, and **rank/merit policy** are all unresolved. This PRP therefore makes grading **fully data-driven** — a configurable `GradingScheme` of bands per school — and states its CBSE-shaped **defaults as inline assumptions**, rather than hard-coding one board's bands. If a school is ICSE/State (D1 keeps the model "generalizable so other regions are later config, not a rewrite"), it edits the scheme; no code change.

There is no `marks`/`grading` module yet; this PRP adds one and the marks-entry surface that PRP-52's teacher grid and PRP-51's report cards consume.

## 2. Goal & non-goals
- **Goal:** a configurable `GradingScheme` + `GradeBand` model covering **both** scholastic bands (mark-range → letter/point) and **co-scholastic scales** (descriptive grades), with a school-level default and per-grade/stream applicability; a `MarksEntry` model recording one student × one `ExamSchedule` (i.e. student × subject × exam) score, plus co-scholastic assessments; a `src/modules/marks/` module with teacher/admin marks entry (single + bulk per section/subject), validation against the schedule's `maxMarks`, grade derivation via the scheme, optional grace-marks, and a lock/finalize step; the `marks.*` / `grading.*` permission strings.
- **Non-goals:** the exam/schedule models themselves (PRP-49), report-card aggregation + PDF + publish + merit lists (PRP-51 — this PRP exposes `getStudentMarks`/`getSubjectGrade` helpers PRP-51 consumes), the FE marks-entry grid (PRP-52), the FE result views (PRP-53), question-level/section-level (within-paper) mark breakdowns (v1 records a single total per paper; a question-wise breakdown is a future extension), moderation workflows beyond a single finalize/lock + audited reopen.

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Import enums from `src/generated/prisma/enums.js`; denormalize `schoolId` on every row (house convention). Marks/points use Prisma `Decimal`, never float (PRP-15 money rule).

```prisma
enum GradeScaleKind {
  SCHOLASTIC      // mark-range → letter grade + grade point (CBSE A1..E)
  CO_SCHOLASTIC   // descriptive grade on a 3/5-point scale (no marks): A..C / A..E
}

// A school-configurable set of bands. A school can have several (e.g. one scholastic
// scheme for the whole school, separate co-scholastic scales). Data-driven (⚠︎ O-P5).
model GradingScheme {
  gradingSchemeId String         @id @default(uuid())
  schoolId        String
  name            String                              // "CBSE Scholastic (default)", "Co-scholastic 5-point"
  scaleKind       GradeScaleKind @default(SCHOLASTIC)
  isDefault       Boolean        @default(false)      // the scheme applied when none is chosen for a grade/subject
  appliesFromLevel Int?                               // optional grade-level range (PRP-29 Grade.level); null = all
  appliesToLevel   Int?
  passingGrade     String?                            // label at/above which a student "passes" (e.g. "D"); ⚠︎ O-P5
  bands           GradeBand[]
  school          School         @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
  @@index([schoolId, scaleKind, isDefault])
}

// One band within a scheme. For SCHOLASTIC, minPercent/maxPercent define the range;
// for CO_SCHOLASTIC, only the label/order matter (no percentage).
model GradeBand {
  gradeBandId     String   @id @default(uuid())
  schoolId        String
  gradingSchemeId String
  grade           String                              // "A1","A2",… or "A","B","C" (co-scholastic)
  minPercent      Decimal? @db.Decimal(5, 2)          // scholastic: inclusive lower bound (e.g. 91.00)
  maxPercent      Decimal? @db.Decimal(5, 2)          // scholastic: inclusive upper bound (e.g. 100.00)
  gradePoint      Decimal? @db.Decimal(4, 2)          // scholastic: CBSE grade point (e.g. 10.0); null for co-scholastic
  sequence        Int                                 // display/rank order (1 = highest)
  scheme          GradingScheme @relation(fields: [gradingSchemeId], references: [gradingSchemeId], onDelete: Cascade)
  school          School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime      @default(now())

  @@unique([gradingSchemeId, grade])
  @@index([schoolId])
  @@index([gradingSchemeId, sequence])
}

// One student's result for one paper (student × subject × exam, via ExamSchedule).
// Subject-awareness (D19): a row exists only if the subject is in the student's StudentSubject roster.
model MarksEntry {
  marksEntryId   String    @id @default(uuid())
  schoolId       String
  academicYearId String                              // denormalized for year-scoped reporting (PRP-28)
  examScheduleId String                              // → ExamSchedule (PRP-49): carries subject + maxMarks
  studentId      String                              // → Student (PRP-29/31)
  marksObtained  Decimal?  @db.Decimal(6, 2)         // null until entered; null + isAbsent=false = not-yet-entered
  graceMarks     Decimal   @db.Decimal(5, 2) @default(0)   // ⚠︎ O-P5: grace policy is school config; stored explicitly
  isAbsent       Boolean   @default(false)
  isExempted     Boolean   @default(false)           // subject not applicable / exempted (e.g. RTE, medical)
  derivedGrade   String?                             // letter grade resolved via the scheme at finalize (denormalized snapshot)
  remarks        String?
  isLocked       Boolean   @default(false)           // finalized; edits require an audited reopen (§3.4)
  enteredByUserId String?                            // who entered (UserSchool/User) — also in audit, kept for quick display
  enteredAt      DateTime?
  examSchedule   ExamSchedule @relation(fields: [examScheduleId], references: [examScheduleId], onDelete: Cascade)
  student        Student      @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school         School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([examScheduleId, studentId])             // one mark per student per paper
  @@index([schoolId])
  @@index([academicYearId, studentId])
  @@index([examScheduleId])
}

// A student's co-scholastic assessment for a term (graded on a CO_SCHOLASTIC scheme, no marks).
// Kept separate from MarksEntry because it is per-term/area, not per-exam-paper.
model CoScholasticAssessment {
  coScholasticId  String   @id @default(uuid())
  schoolId        String
  academicYearId  String
  termId          String                              // co-scholastic is reported per term (D18)
  studentId       String
  area            String                              // "Work Education","Art Education","Health & Physical","Discipline" (⚠︎ O-P5)
  gradingSchemeId String                              // the CO_SCHOLASTIC scheme used
  grade           String                              // the awarded descriptive grade ("A".."E")
  remarks         String?
  isLocked        Boolean  @default(false)
  student         Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school          School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([academicYearId, termId, studentId, area])
  @@index([schoolId])
  @@index([academicYearId, termId, studentId])
}
```
Add back-relations to `School` (`gradingSchemes`, `gradeBands`, `marksEntries`, `coScholasticAssessments`), to `ExamSchedule` (`marksEntries`, PRP-49), and to `Student` (`marksEntries`, `coScholasticAssessments` — coordinate the shared `Student` edit, see §8). `MarksEntry.examScheduleId` reaches the subject + `maxMarks` through `ExamSchedule`, so `MarksEntry` does **not** redundantly store `subjectId`/`maxMarks` (single source of truth).

> **Decision — data-driven bands, CBSE defaults as a seeded assumption (⚠︎ O-P5):** because the CBSE bands, co-scholastic scales, grace policy, and pass mark are **open (O-P5)**, grading is a `GradingScheme` of `GradeBand` rows the school edits, **not** a hard-coded table. A seed helper installs a **CBSE-shaped default** (assumption, stated inline below) at school activation, which the school can override. This satisfies D1's "generalizable so other regions are later config, not a rewrite."
>
> **Assumed CBSE scholastic default (editable; resolve at O-P5):** A1 91–100 (10.0), A2 81–90 (9.0), B1 71–80 (8.0), B2 61–70 (7.0), C1 51–60 (6.0), C2 41–50 (5.0), D 33–40 (4.0), E 0–32 (fail). **Assumed co-scholastic default:** a 5-point A–E (or 3-point A–C) descriptive scale, no points. **Assumed pass mark:** 33%. **Grace marks:** off by default; a per-`MarksEntry` `graceMarks` field exists so a school can apply a configured grace policy when O-P5 fixes the rule. These are placeholders; none is wired as an immutable constant.

> **Decision — grade is derived at finalize and snapshotted:** `derivedGrade` is computed from `(marksObtained + graceMarks) / maxMarks` against the applicable `GradingScheme` **when a marks row is locked/finalized**, and stored on the row. Snapshotting means a later scheme edit does not silently rewrite already-published results (history correctness, akin to PRP-29's offering-vs-roster note). Live (pre-finalize) grade preview is computed on read by the same pure helper.

### 3.2 Effective-grade computation (pure helper)
A pure, unit-testable `resolveGrade(scheme, percent) → { grade, gradePoint }` in `src/modules/marks/grading.resolve.ts` is the single source of truth for scholastic grading: it finds the band whose `[minPercent, maxPercent]` contains `percent` and returns its `grade`/`gradePoint`. Co-scholastic "grades" are entered directly (no marks), so they are validated against the scheme's band labels rather than computed. The helper is reused by the live preview (read path), the finalize snapshot (§3.1), and PRP-51's aggregation.

### 3.3 Module layout (`src/modules/marks/`)
New school-scoped module, house split, registered under `src/plugins/school.plugin.ts`:
- `marks.routes.ts` / `marks.controller.ts` / `marks.service.ts` / `marks.schema.ts` / `marks.types.ts` — marks entry + co-scholastic + the read helpers.
- `grading.routes.ts` / `grading.controller.ts` / `grading.service.ts` / `grading.schema.ts` / `grading.types.ts` — `GradingScheme`/`GradeBand` CRUD + seeding (kept in the same module folder; both are P5 grading concerns).
- `grading.resolve.ts` — the pure §3.2 helper.

### 3.4 Services & routes
`grading.service.ts` (`fastify`-first, tenant-scoped):
- `createGradingScheme` / `listGradingSchemes` / `updateGradingScheme` / `setGradeBands(schemeId, bands[])` (full-replace; validates scholastic bands are contiguous + non-overlapping across 0–100 and that exactly one default exists per `scaleKind`); `seedDefaultSchemes(fastify, schoolId)` installs the §3.1 CBSE-shaped assumption (idempotent; callable at activation or on demand). All audited (PRP-18).

`marks.service.ts` (`fastify`-first, tenant-scoped; teacher rights resolved via `TeacherAssignment`, PRP-30):
- `getMarksSheet(fastify, schoolId, examScheduleId)` — returns the **roster to mark**: every enrolled student (PRP-32) of the schedule's grade whose `StudentSubject` (PRP-29, D19) includes the paper's subject, with any existing `MarksEntry`. This is the grid PRP-52 renders. **Authorization:** a TEACHER may call this only for a schedule whose `Section`×`Subject` they are assigned (`TeacherAssignment`, PRP-30); ADMIN/STAFF unrestricted. The "may-mark" check is a service helper `assertCanMarkSchedule(fastify, ctx, examScheduleId)`.
- `upsertMarks(fastify, schoolId, examScheduleId, [{ studentId, marksObtained?, graceMarks?, isAbsent?, isExempted?, remarks? }])` — bulk upsert in a transaction; validates `0 ≤ marksObtained + graceMarks ≤ maxMarks` (the schedule's), that each student is in the eligible roster (subject-aware), and that the row is **not locked**; computes a live `derivedGrade` preview but only snapshots it at finalize. Records `enteredByUserId`/`enteredAt`. Same `assertCanMarkSchedule` gate.
- `finalizeMarks(fastify, schoolId, examScheduleId)` — locks all rows for the schedule (`isLocked: true`), snapshots `derivedGrade` via `resolveGrade`, and audits (`action: 'marks.finalized'`). `reopenMarks(fastify, schoolId, examScheduleId)` — ADMIN-only, unlocks for correction, **mandatorily audited** (`action: 'marks.reopened'`, D22 critical action).
- Co-scholastic: `upsertCoScholastic(fastify, schoolId, { termId, [{ studentId, area, gradingSchemeId, grade, remarks? }] })` — validates each `grade` against the chosen CO_SCHOLASTIC scheme's bands; lock/finalize mirror scholastic.
- **Read helpers for PRP-51:** `getStudentMarks(fastify, schoolId, studentId, { academicYearId, termId?, examId? })` and `getSectionResults(fastify, schoolId, examId, sectionId)` — exported so PRP-51 aggregates report cards and merit lists without re-querying raw tables.

Routes (school-scoped subtree; `requirePermission`, PRP-17; mutations `requireWritableSchool`, PRP-15):
- Grading: `POST|GET /api/school/grading-schemes` (`grading.manage`/`grading.read`), `PATCH /api/school/grading-schemes/:gradingSchemeId` + `PUT /api/school/grading-schemes/:gradingSchemeId/bands` (`grading.manage`)
- Marks sheet: `GET /api/school/exam-schedules/:examScheduleId/marks` (`marks.read`)
- Enter marks: `PUT /api/school/exam-schedules/:examScheduleId/marks` (`marks.enter`)
- Finalize/reopen: `POST /api/school/exam-schedules/:examScheduleId/marks/finalize` (`marks.enter`), `POST /api/school/exam-schedules/:examScheduleId/marks/reopen` (`marks.manage`)
- Co-scholastic: `PUT /api/school/co-scholastic` (`marks.enter`)

### 3.5 Permission strings (extends PRP-17 §3.4)
A teacher may **enter** marks (scoped to their assignments) but not configure grading schemes or reopen finalized marks; co-scholastic entry is `marks.enter` (often a class teacher). The "teacher only their assignments" restriction is enforced in the service via `assertCanMarkSchedule`, not the matrix (mirrors PRP-30's "own assignments" rule).

| Resource | Actions (P5) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `grading` | `read`, `manage` | read+manage | read | read | – | – |
| `marks` | `read`, `enter`, `manage` | all | read+enter | enter (own assignments §3.4), read (own) | – (results via PRP-51 publish) | – (results via PRP-51 publish) |

> **Note — students/parents do not read raw `marks` here.** Result visibility to students/parents is gated by the **publish** step in PRP-51 (a result is visible only once published), not by a `marks.read` grant. Keep `marks.read` to staff/teacher; PRP-51 owns the published-result read surface.

## 4. Implementation steps
1. **Schema:** add `GradeScaleKind`, `GradingScheme`, `GradeBand`, `MarksEntry`, `CoScholasticAssessment` + the `School`/`ExamSchedule`/`Student` back-relations to `prisma/schema.prisma` (coordinate the `Student` edit with PRP-29/31). `pnpm exec prisma migrate dev --name grading_and_marks` then `pnpm prisma:generate`.
2. **Module:** add `src/modules/marks/{marks,grading}.{routes,controller,service,schema,types}.ts` + `grading.resolve.ts`. Controllers thin; services `fastify`-first; enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Grading services + seed:** implement scheme/band CRUD with contiguity/overlap validation and `seedDefaultSchemes` (the §3.1 CBSE-shaped assumption, idempotent). Implement the pure `resolveGrade` helper with unit tests.
4. **Marks services:** implement `getMarksSheet` (subject-aware eligible roster), `upsertMarks` (range + roster + not-locked validation), `finalizeMarks`/`reopenMarks` (lock + snapshot + audit), co-scholastic upsert, and the `getStudentMarks`/`getSectionResults` helpers PRP-51 imports. Implement `assertCanMarkSchedule` against `TeacherAssignment` (PRP-30).
5. **Routing + guards:** register both route files under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; teacher row-scoping in the service.
6. **Permissions:** add `grading.*` / `marks.*` to `src/modules/authz/permissions.ts` (PRP-17); re-run `pnpm seed:permissions`.
7. **Audit:** `writeAudit()` (PRP-18) on scheme/band changes, `marks.finalized`, `marks.reopened` (D22 critical), and co-scholastic finalize.
8. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + request/response types.

## 5. Files added / changed
- **Add:** `src/modules/marks/marks.routes.ts`, `marks.controller.ts`, `marks.service.ts`, `marks.schema.ts`, `marks.types.ts`, `grading.routes.ts`, `grading.controller.ts`, `grading.service.ts`, `grading.schema.ts`, `grading.types.ts`, `grading.resolve.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `grading.*`/`marks.*`), and the PRP-49 `ExamSchedule` / PRP-29 `Student` models for back-relations (coordinate)

## 6. Acceptance criteria
- [ ] `GradingScheme`/`GradeBand`/`MarksEntry`/`CoScholasticAssessment` tables exist with the documented constraints; all carry `schoolId`; marks are year-scoped and unique per (schedule, student).
- [ ] `setGradeBands` rejects overlapping/non-contiguous scholastic bands and more than one default per `scaleKind`; `seedDefaultSchemes` installs the editable CBSE-shaped default idempotently.
- [ ] `resolveGrade` has unit tests covering each band boundary (e.g. 90.99→A2, 91.00→A1), the fail band, and the no-band/out-of-range case.
- [ ] `getMarksSheet` returns exactly the **subject-aware** eligible roster (students whose `StudentSubject` includes the paper's subject, D19) — proven for an 11-Science vs. 11-Commerce mix.
- [ ] `upsertMarks` rejects `marksObtained + graceMarks > maxMarks`, a student not in the eligible roster, and any write to a **locked** row; it records `enteredByUserId`/`enteredAt`.
- [ ] A TEACHER can enter marks **only** for their assigned `Section`×`Subject` (`TeacherAssignment`, PRP-30); an unassigned schedule returns 403; ADMIN/STAFF unrestricted.
- [ ] `finalizeMarks` locks rows and snapshots `derivedGrade`; `reopenMarks` is ADMIN-only and audited; a later scheme edit does not change already-snapshotted grades.
- [ ] Co-scholastic grades validate against the chosen CO_SCHOLASTIC scheme's band labels.
- [ ] Marks finalize/reopen are audited (PRP-18 / D22).
- [ ] ⚠︎ The O-P5 assumptions (bands, co-scholastic scales, grace, pass mark) are recorded inline and the scheme is fully editable (no hard-coded board table).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name grading_and_marks` applies; `pnpm seed:permissions` adds the new strings.
- Manual: seed default schemes → create a Half-Yearly exam + schedules (PRP-49) → as the assigned Maths teacher, open the Class-10 Maths marks sheet (only Maths-takers listed), enter marks (reject 105/100), finalize → grades snapshot; reopen as Admin (audited); enter a co-scholastic grade for "Work Education"; attempt entry as an unassigned teacher → 403.

## 8. Risks & rollback
- **⚠︎ O-P5 is the defining risk:** CBSE bands, co-scholastic scales, grace, term weightage, pass mark, and rank policy are **unresolved**. Mitigation: everything is a configurable `GradingScheme`/`GradeBand`; CBSE-shaped values are **seeded defaults stated inline**, not constants. Resolving O-P5 = editing the seed/scheme, not the schema. PRP-51 inherits this configurability for aggregation/merit.
- **Subject-awareness (D19):** the eligible roster **must** derive from `StudentSubject`, not "the whole grade/section" — otherwise a Commerce student gets a Physics marks row. Cover with the senior-secondary mix test.
- **Snapshot vs. live grade:** `derivedGrade` is snapshotted at finalize so published results are immutable under later scheme edits (history). Never recompute and overwrite a locked row's grade; the live preview uses the same pure helper but does not persist.
- **Lock discipline + audit (D22):** marks edits are a logged critical action; `reopenMarks` must be ADMIN-only and always audited — a silent reopen is the worst outcome. The `isLocked` guard in `upsertMarks` is the safety rail.
- **Decimal for marks/points:** `marksObtained`/`graceMarks`/`gradePoint`/`minPercent`/`maxPercent` are Prisma `Decimal`; never float (rounding at band boundaries must be deterministic).
- **Shared `Student`/`ExamSchedule` edits:** adding relations touches PRP-29/31's `Student` and PRP-49's `ExamSchedule`; coordinate the migration (same hazard PRP-29 §8 flags).
- **Rollback:** additive module + tables; revert the module, drop the four tables, and drop the `Student`/`ExamSchedule` back-relations (coordinate). Inert until routes are registered.
