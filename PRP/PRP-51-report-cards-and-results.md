# PRP-51 — Report cards (PDF), result publishing & merit lists

> **Status:** Proposed · **Phase:** 5 · **Severity:** 🔴 High · **Size:** L
> **Depends on:** PRP-50 (`MarksEntry` + `CoScholasticAssessment` + `GradingScheme` — the report card aggregates these and applies the scheme; `getStudentMarks`/`getSectionResults`/`resolveGrade` helpers), PRP-49 (`Exam`/`ExamType.weightage` — term aggregation weights exam types; report cards align to a `Term`), PRP-46 (the **canonical** server-side PDF + storage service — `src/modules/pdf/pdf.service.ts`'s object-arg `renderPdf({ template, data })` + `src/lib/storage/`; this PRP adds only report-card/marksheet templates, no new PDF library), PRP-29 (`Subject`/`StudentSubject` — the per-subject rows are subject-aware), PRP-32 (`Enrollment` — a report card is for an enrolled student in a section/year), PRP-28 (year/term), PRP-12 (school context), PRP-17 (RBAC — new `report_card.*` / `result.*` strings), PRP-15 (`requireWritableSchool` on publish), PRP-18 (audit — result publish is a D22 critical action), PRP-41 (parent portal APIs — reuse its `resolveParentChildren` guard + fill its reserved `parent.read_child_results` permission and `results` dashboard slot) · **Feeds:** PRP-53 (FE result + report-card viewing for admin/teacher/parent/student), PRP-41's dashboard `results` slot (this PRP populates it)

## 1. Problem / current state
PRP-49 + PRP-50 give the platform exams, subject-aware marks, and a configurable grading scheme — but there is **no report card**, **no notion of a result being "published"** (so students/parents can't see anything yet — by design, PRP-50 keeps `marks.read` to staff), and **no merit/rank list**. Decision **D1** targets **CBSE-style report cards**; master-prp §6 (P5) lists "report-card/marksheet PDFs, result publishing, merit lists" as headline deliverables and §5.7 lists `ReportCard` as the P5 entity. The implementation-plan row for PRP-51 carries the **⚠︎** flag for **O-P5**.

This PRP is the **third and final** P5 backend PRP: it **aggregates** a term's `MarksEntry` + co-scholastic assessments into a `ReportCard` (computing per-subject grades, term totals/percentage, overall grade, result status, and — per a configurable policy — rank), renders a **CBSE-style PDF** (reusing **PRP-46's** canonical `src/modules/pdf/` renderer — object-arg `renderPdf({ template, data })` — with new report-card/marksheet templates), and **publishes** results so the existing parent/student roles can read them (consumed by PRP-53). It must keep grading **data-driven** (the bands, term **weightage**, and **rank policy** are O-P5 — stated as inline assumptions, not hard-coded).

## 2. Goal & non-goals
- **Goal:** a `ReportCard` model (per student × term × year) that snapshots the aggregated result, plus a `ResultPublication` record gating visibility; a `src/modules/report-card/` module that **computes** the aggregate via PRP-50's helpers + a configurable **term-weightage** and **rank** policy, **renders** a CBSE-style report-card / marksheet PDF (new templates in **PRP-46's shared `src/modules/pdf/`**, via the object-arg `renderPdf({ template, data })`), **publishes** a section/grade's results (flips visibility, audited), exposes a **published-result read** for students/parents (scoped to own/children), and produces **merit lists** (rank within section/grade for an exam or a term). The grading/weightage/rank policy is **configurable / data-driven** with CBSE-shaped defaults stated inline.
- **Non-goals:** marks entry + grading-scheme CRUD (PRP-50), the exam timetable/admit card (PRP-49), the FE result/report-card screens (PRP-53), notification delivery of "results published" (the **trigger** is wired to the notification engine in P6/PRP-54 — this PRP exposes a publish event/hook and audits it, but does not send SMS/push/email), certificate/transcript generation across years (P8/PRP-66 — this is a single-term report card, not a cumulative transcript), CGPA-across-years.

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Import enums from `src/generated/prisma/enums.js`; denormalize `schoolId`; `Decimal` for all marks/percent/points (PRP-15 rule).

```prisma
enum ResultStatus {
  PASS
  FAIL
  COMPARTMENT     // CBSE "compartment"/supplementary — one/two subjects to re-sit (⚠︎ O-P5 policy)
  WITHHELD        // result withheld (e.g. fees/discipline) — not shown even if published
  ABSENT          // did not sit the exams
}

// A snapshotted, aggregated result for a student for a term (or a whole-year "Annual" exam).
// Snapshot at publish so later marks/scheme edits don't silently rewrite a released card.
model ReportCard {
  reportCardId    String       @id @default(uuid())
  schoolId        String
  academicYearId  String                              // year-scoped (PRP-28)
  termId          String                              // a report card is per term (D18); annual = the final term/exam
  studentId       String
  sectionId       String                              // resolved from Enrollment (PRP-32) at generation
  gradingSchemeId String?                             // the scholastic scheme applied (snapshot ref)
  totalMarks      Decimal?     @db.Decimal(8, 2)      // sum of subject obtained (scholastic)
  maxTotalMarks   Decimal?     @db.Decimal(8, 2)
  percentage      Decimal?     @db.Decimal(5, 2)
  overallGrade    String?                             // derived overall letter (via scheme)
  cgpa            Decimal?     @db.Decimal(4, 2)       // ⚠︎ O-P5: optional CBSE-style grade-point average
  resultStatus    ResultStatus @default(PASS)
  rank            Int?                                 // within section/grade per the configured rank policy (⚠︎ O-P5)
  attendancePct   Decimal?     @db.Decimal(5, 2)       // optional: pulled from P3 attendance if available; else null
  remarks         String?                              // class-teacher remark
  subjects        ReportCardSubject[]                  // per-subject snapshot rows
  isPublished     Boolean      @default(false)         // mirrors ResultPublication; quick filter
  publishedAt     DateTime?
  generatedAt     DateTime     @default(now())
  school          School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  student         Student      @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  @@unique([academicYearId, termId, studentId])       // one card per student per term
  @@index([schoolId])
  @@index([academicYearId, termId, sectionId])
  @@index([isPublished])
}

// Per-subject snapshot inside a report card (subject-aware, D19).
model ReportCardSubject {
  reportCardSubjectId String   @id @default(uuid())
  schoolId            String
  reportCardId        String
  subjectId           String
  subjectName         String                          // snapshot label (subject may be renamed later)
  marksObtained       Decimal? @db.Decimal(6, 2)      // term-aggregated (weighted across exam types — §3.2)
  maxMarks            Decimal? @db.Decimal(6, 2)
  grade               String?                          // per-subject letter (via scheme)
  gradePoint          Decimal? @db.Decimal(4, 2)
  isCoScholastic      Boolean  @default(false)         // true → descriptive grade, no marks (from CoScholasticAssessment)
  reportCard          ReportCard @relation(fields: [reportCardId], references: [reportCardId], onDelete: Cascade)
  school              School     @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)

  @@unique([reportCardId, subjectId])
  @@index([schoolId])
}

// Gates visibility of a batch of results to students/parents. Publishing a section/grade
// for a term creates one of these; report cards reference it via isPublished/publishedAt.
model ResultPublication {
  resultPublicationId String   @id @default(uuid())
  schoolId            String
  academicYearId      String
  termId              String
  gradeId             String?                          // scope: a grade…
  sectionId           String?                          // …or a single section; null+null = whole-year batch
  examId              String?                          // optional: publishing a single exam's marks vs. a term's report cards
  publishedByUserId   String?
  publishedAt         DateTime @default(now())
  isRevoked           Boolean  @default(false)         // un-publish (audited)
  revokedAt           DateTime?
  school              School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt           DateTime @default(now())

  @@index([schoolId])
  @@index([academicYearId, termId])
}
```
Add back-relations to `School` (`reportCards`, `reportCardSubjects`, `resultPublications`) and to `Student` (`reportCards` — coordinate the shared `Student` edit, §8).

> **Decision — snapshot at generation/publish (history correctness):** the `ReportCard` + `ReportCardSubject` rows are a **snapshot** of the aggregated result, not a live view. Regenerating (before publish) recomputes them; after publish they are frozen unless an audited revoke→regenerate→republish cycle runs. This mirrors PRP-50's `derivedGrade` snapshot and PRP-29's offering-vs-roster history note: a released card must not silently change when a teacher later edits a mark.

> **Decision — publish gates visibility, not `marks.read`:** students/parents never read raw `MarksEntry` (PRP-50). A result becomes visible **only** when a `ResultPublication` covering the student's (term, section/grade) exists and is not revoked, and the card is not `WITHHELD`. The published-result read service (§3.4) enforces this; PRP-53 consumes it.

### 3.2 Aggregation, weightage & rank — configurable (⚠︎ O-P5)

> **Scope — term-final report cards only (annual cross-term aggregation deferred):** a `ReportCard` is **per (student, term, year)**. Aggregation here combines a **single term's** exams (weighted by `ExamType.weightage`) into that term's card. **True annual / cross-term aggregation** — rolling Term-1 + Term-2 + … into one cumulative year-end result (e.g. CBSE's annual result combining periodic + term exams across the whole year) — is **out of scope for v1**: an "Annual" exam is modeled as just another term's card (the final term/exam), not a computed roll-up across terms. When a school needs genuine cross-term aggregation, it is an **additive extension to `aggregate.ts`** (a new `weightageMode` spanning terms + a year-level `ReportCard` scope), not a schema change — flagged here so reviewers don't assume the year-end card aggregates prior terms. (`cgpa`-across-years is likewise deferred, §2 non-goals.)

Aggregation is a **pure, configurable** computation in `src/modules/report-card/aggregate.ts`, fed by PRP-50's `getStudentMarks` + `resolveGrade`:
- **Per-subject term mark:** combine a subject's `MarksEntry` rows across the term's exams using **`ExamType.weightage`** (PRP-49). ⚠︎ **O-P5 (term weightage):** the exact weighting (e.g. 10% UT1 + 10% UT2 + 80% Half-Yearly, or "best-of") is **open**. **Assumption (stated inline):** if `weightage` is set on the exam types, use a weighted average normalized to 100%; if unset, fall back to the single term-final exam, or an equal-weighted average — pick per a `schoolId`-level **`ResultPolicy` config** (see below). No weighting rule is hard-coded.
- **Overall grade / percentage / CGPA:** percentage = weighted subject total ÷ max; overall grade via `resolveGrade`; `cgpa` = mean of subject `gradePoint`s **if** the policy enables it (⚠︎ O-P5 — CBSE CGPA optional).
- **Result status:** PASS/FAIL/COMPARTMENT per the scheme's `passingGrade` + a configurable compartment threshold (⚠︎ O-P5 — "compartment in ≤2 subjects" is the common CBSE rule, stated as the assumed default, configurable).
- **Rank policy:** ⚠︎ **O-P5 (rank/merit policy):** whether rank is by total marks, by CGPA, dense vs. competition ranking, within-section vs. within-grade, and whether ranks are shown to students at all — is **open**. **Assumption:** rank by percentage within **section** by default, competition ranking (ties share a rank), and rank is computed but its **visibility** is a policy flag (many schools hide individual ranks). All four knobs live in the `ResultPolicy` config; nothing is hard-coded.

> **`ResultPolicy` (config, not a hard-coded constant):** a small per-school config — `weightageMode` (`WEIGHTED` | `TERM_FINAL` | `EQUAL` | `BEST_OF`), `enableCgpa`, `compartmentMaxSubjects`, `rankScope` (`SECTION` | `GRADE` | `NONE`), `rankMode` (`COMPETITION` | `DENSE`), `showRankToStudent`. Stored as a `Json` column on the school's grading config or a dedicated small table (decide in review — prefer a typed table `ResultPolicy` keyed by `schoolId` for queryability). Seeded with the CBSE-shaped assumptions above; fully editable. This is the single place O-P5's policy answers land.

### 3.3 Module layout (`src/modules/report-card/`)
New school-scoped module, house split, registered under `src/plugins/school.plugin.ts`:
- `report-card.routes.ts` / `report-card.controller.ts` / `report-card.service.ts` / `report-card.schema.ts` / `report-card.types.ts` — generation, publish, read, merit, PDF.
- `aggregate.ts` — the pure §3.2 aggregation/rank computation (unit-tested).
- Reuses **PRP-46's canonical `src/modules/pdf/pdf.service.ts`** (object-arg `renderPdf({ template, data })`); adds `src/modules/pdf/templates/report-card.*` (CBSE-style) + `src/modules/pdf/templates/marksheet.*` to PRP-46's shared template directory + registry. No new PDF library/util.

### 3.4 Services & routes
`report-card.service.ts` (`fastify`-first, tenant-scoped; year/term default via `resolveCurrentAcademicYear`, PRP-28):
- `generateReportCards(fastify, schoolId, { academicYearId?, termId, sectionId?|gradeId? })` — for each enrolled student (PRP-32) in scope: pull marks (`getStudentMarks`, PRP-50) + co-scholastic, run `aggregate.ts` (applying `ResultPolicy`), upsert `ReportCard` + `ReportCardSubject` rows, compute rank across the scope. Idempotent (re-runnable until published). Audited.
- `getReportCard(fastify, schoolId, studentId, { academicYearId, termId })` — staff/teacher read of the (possibly unpublished) card.
- `generateReportCardPdf(fastify, schoolId, studentId, { termId }) → Buffer` — renders via PRP-46's object-arg `renderPdf({ template: 'report-card', data })`; `generateSectionReportCardsPdf(...)` concatenates a section for bulk printing (size-bounded; if heavy, defer to a PRP-05-style job — flagged, see §8). A `marksheet` template variant (`renderPdf({ template: 'marksheet', data })`) renders a single-exam marksheet.
- `publishResults(fastify, schoolId, { academicYearId?, termId, sectionId?|gradeId?, examId? })` — creates a `ResultPublication`, flips `ReportCard.isPublished`/`publishedAt` in scope, audits (`action: 'result.published'`, D22 critical), and **fires a publish event/hook** the P6 notification engine (PRP-54) will subscribe to (no-op until then). `revokeResults(...)` — un-publish, audited (`action: 'result.revoked'`).
- **Published-result read (student/parent surface):** `getPublishedResult(fastify, ctx, studentId, { academicYearId, termId })` — returns the card **only if** a non-revoked `ResultPublication` covers it and `resultStatus !== WITHHELD`. **Ownership:** STUDENT → own only; PARENT → linked children only. Reuse **PRP-41's `resolveParentChildren(fastify, parentUserId, { schoolId })`** as the parent↔child authorization gate (a `studentId` not in the caller's linked children → `403/404`, don't leak existence) rather than re-implementing the `ParentStudent` join — this is the same guard PRP-41 mandates for every child-scoped read. This PRP also **fills PRP-41's reserved `results` dashboard slot** (PRP-41 §3.4 stubs it for P5) by exposing a compact per-child published-result summary `getChildResultSummary(fastify, studentId, { academicYearId })` the parent dashboard composes.
- **Merit list:** `getMeritList(fastify, schoolId, { academicYearId?, termId?, examId?, sectionId?|gradeId?, limit? })` — ranked list per the `ResultPolicy` rank policy; respects `rankScope`/`showRankToStudent` (staff see full; a student-facing merit list, if enabled, is a separate gated read).
- **Result policy config:** `getResultPolicy(fastify, schoolId)` / `upsertResultPolicy(fastify, schoolId, { weightageMode, enableCgpa, compartmentMaxSubjects, rankScope, rankMode, showRankToStudent })` — read/edit the per-school `ResultPolicy` (§3.2). This is the single place an admin tunes the O-P5 knobs; seeded with the CBSE-shaped defaults on first read. Audited (`result_policy.update`). Without this surface the `ResultPolicy` table would have no edit path — every aggregation knob must be reachable here.

Routes (school-scoped subtree; `requirePermission`, PRP-17; mutations `requireWritableSchool`, PRP-15):
- Generate: `POST /api/school/report-cards/generate` (`report_card.manage`)
- Staff read: `GET /api/school/report-cards/:studentId?termId=` (`report_card.read`)
- PDF: `GET /api/school/report-cards/:studentId/pdf?termId=` (`report_card.read`, ownership-scoped for student/parent) → `application/pdf`; bulk `GET /api/school/report-cards/pdf?sectionId=&termId=` (`report_card.manage`) → `application/pdf`
- Publish/revoke: `POST /api/school/results/publish` (`result.publish`), `POST /api/school/results/revoke` (`result.publish`)
- Published read (student/parent): `GET /api/school/results/:studentId?termId=` (`result.read`, ownership-scoped) → published card or 404/forbidden if unpublished
- Merit: `GET /api/school/results/merit` (`result.read` for staff; student visibility per policy)
- Result policy: `GET /api/school/results/policy` (`result_policy.read`), `PUT /api/school/results/policy` (`result_policy.manage`) — read/edit the per-school `ResultPolicy` (§3.2)

### 3.5 Permission strings (extends PRP-17 §3.4)
Staff/teacher use `result.read` / `result.publish` / `report_card.*` (scoped to own sections for teachers in the service — PRP-30 pattern). The per-school `ResultPolicy` config (§3.2) is gated by a small **`result_policy`** resource (`read`/`manage`, ADMIN — STAFF optional), so the O-P5 aggregation knobs have a real edit route instead of an unreachable table. The **parent** reads published results via PRP-41's reserved **`parent.read_child_results`** permission (PRP-41 §3.3 reserves the name for P5 to seed) — this PRP seeds it into PRP-17's PARENT row and gates the parent read with it + the `resolveParentChildren` link check, rather than granting parents the staff-side `result.read`. A **student** reads their own via `result.read` scoped to self in the service.

| Resource | Actions (P5) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `report_card` | `read`, `manage` | read+manage | read+manage | read (own sections) | – (uses `result.read`) | – (uses `parent.read_child_results`) |
| `result` | `read`, `publish` | read+publish | read+publish | read (own sections) | read (own, published §3.4) | – (uses `parent.read_child_results`) |
| `result_policy` | `read`, `manage` | read+manage | read (manage optional) | – | – | – |
| `parent` (PRP-41) | `read_child_results` | – | – | – | – | read (children, published §3.4) |

## 4. Implementation steps
1. **Schema:** add `ResultStatus`, `ReportCard`, `ReportCardSubject`, `ResultPublication` (+ the `ResultPolicy` table, §3.2) + `School`/`Student` back-relations to `prisma/schema.prisma` (coordinate the `Student` edit). `pnpm exec prisma migrate dev --name report_cards_and_results` then `pnpm prisma:generate`.
2. **Module:** add `src/modules/report-card/{routes,controller,service,schema,types}.ts` + `aggregate.ts`. Controllers thin; service `fastify`-first; enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Aggregation:** implement the pure `aggregate.ts` (subject term-mark via `ExamType.weightage` + `ResultPolicy`, overall grade/percentage/CGPA via PRP-50's `resolveGrade`, result status, rank) with unit tests for the weightage modes, compartment threshold, and tie ranking. Seed `ResultPolicy` with the CBSE-shaped assumptions.
4. **PDF templates:** add `src/modules/pdf/templates/report-card.*` (CBSE-style) + `marksheet.*` to PRP-46's shared PDF module + registry, rendered through PRP-46's object-arg `renderPdf({ template, data })` (no new PDF library). Keep the layout **template-driven / data-fed** (⚠︎ O-P5 template — no hard-coded board-specific structure baked into code).
5. **Services:** implement `generateReportCards` (idempotent pre-publish), `publishResults`/`revokeResults` (audited + publish hook for PRP-54), the ownership-scoped `getPublishedResult`, and `getMeritList` honoring the rank policy.
6. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; student/parent ownership scoping in the read services.
7. **Permissions:** add `report_card.*` / `result.*` / `result_policy.*` to `src/modules/authz/permissions.ts` (PRP-17) and **seed PRP-41's reserved `parent.read_child_results` into the PARENT row** (PRP-41 §3.3 reserves the name for P5); re-run `pnpm seed:permissions`.
8. **Audit + publish hook:** `writeAudit()` (PRP-18) on generate, `result.published`, `result.revoked` (D22); emit a publish event the P6 notification engine (PRP-54) can subscribe to (no-op until then).
9. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + types; PDF routes declare `application/pdf` (document the envelope exception).

## 5. Files added / changed
- **Add:** `src/modules/report-card/report-card.routes.ts`, `report-card.controller.ts`, `report-card.service.ts`, `report-card.schema.ts`, `report-card.types.ts`, `aggregate.ts`; `src/modules/pdf/templates/report-card.*`, `src/modules/pdf/templates/marksheet.*` (new templates in PRP-46's shared PDF module — **no** new PDF library/util)
- **Edit:** `prisma/schema.prisma` (+ migration; `ReportCard`/`ReportCardSubject`/`ResultPublication`/`ResultPolicy` + `Student` back-relation), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `report_card.*`/`result.*`/`result_policy.*`), `src/modules/pdf/pdf.registry.ts` (register the `report-card`/`marksheet` templates — PRP-46's registry)

## 6. Acceptance criteria
- [ ] `ReportCard`/`ReportCardSubject`/`ResultPublication`/`ResultPolicy` tables exist with the documented constraints; all carry `schoolId`; one card per (student, term, year).
- [ ] `generateReportCards` aggregates a term's marks per the `ResultPolicy` weightage mode, computes per-subject grades (subject-aware, D19), overall grade/percentage, result status, and rank, and snapshots them; re-running before publish recomputes.
- [ ] The report-card PDF renders CBSE-style via **PRP-46's** shared `src/modules/pdf/` renderer (object-arg `renderPdf({ template, data })`) and lists **only the student's subjects** (their `StudentSubject` set) plus co-scholastic grades.
- [ ] `publishResults` creates a `ResultPublication`, flips `isPublished`, is audited (D22), and emits the publish hook; `revokeResults` un-publishes and is audited.
- [ ] A STUDENT/PARENT can read a result **only after publish** and **only their own/children's** — the parent path goes through PRP-41's `resolveParentChildren` link check + the new `parent.read_child_results` permission; an unpublished or `WITHHELD` result is not returned, and an unlinked `studentId` returns `403/404`.
- [ ] `getMeritList` ranks per the configured `ResultPolicy` (scope/mode/tie handling) and respects `showRankToStudent`.
- [ ] All routes tenant-scoped + permission-guarded; mutations 403/402 on a non-writable school (PRP-15).
- [ ] The per-school `ResultPolicy` is **editable via a real route** (`GET`/`PUT /api/school/results/policy`, gated by `result_policy.read`/`result_policy.manage`), audited on change — not an unreachable table.
- [ ] ⚠︎ O-P5 assumptions (weightage mode, compartment threshold, CGPA on/off, rank policy, report-card template) are recorded inline and live in editable `ResultPolicy` config / template-driven PDF — none hard-coded. Report cards are **term-final only**; cross-term annual aggregation is documented as a deferred additive extension to `aggregate.ts`.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name report_cards_and_results` applies; `pnpm seed:permissions` adds the new strings.
- Manual (against PRP-49/50 data): finalize a term's marks → `generateReportCards` for a section → inspect a card's per-subject grades, percentage, status, rank → render its PDF (CBSE-style, only the student's subjects) → `publishResults` → fetch as the student (visible) and as their parent (visible), as an unrelated parent (forbidden), and before publish (404/forbidden); pull a merit list and confirm tie ranking + `showRankToStudent` behavior.

## 8. Risks & rollback
- **⚠︎ O-P5 is the defining risk (shared with PRP-50):** term weightage, rank/merit policy, compartment rule, CGPA, and the report-card **template** are all open. Mitigation: a per-school `ResultPolicy` config + template-driven PDF + CBSE-shaped **seeded** defaults stated inline. Resolving O-P5 = editing config/template, not code. Do not bake any board's rule into `aggregate.ts` or the template structure.
- **Snapshot vs. live + publish immutability:** a published card must not change when a mark is later edited — snapshot at generate, freeze at publish, and require an **audited** revoke→regenerate→republish to change a released result. The worst outcome is silently altered released results; the publish/snapshot discipline is the safety rail (mirrors PRP-50's `derivedGrade`).
- **Visibility safety:** the published-result read **must** check both a non-revoked `ResultPublication` and `resultStatus !== WITHHELD`, and scope to own/children. A leak (showing an unpublished/withheld result, or another family's child) is the highest-severity bug — cover ownership + publication with tests. The parent/child resolver is **PRP-41's `resolveParentChildren`** (the single guardian-edge gate) — reuse it, do not re-implement the `ParentStudent` join, so the link rule stays single-sourced.
- **PDF reuse + bulk cost:** reuse **PRP-46's** canonical `renderPdf({ template, data })` (one library platform-wide, not a second) — add only templates, never a parallel `src/utils/pdf/`. Bulk section/grade report-card generation can be heavy — size-bound it and defer to a PRP-05-style job if it grows; do not block the request thread for a whole grade.
- **Decimal everywhere:** totals/percentages/points are `Decimal`; rounding (e.g. percentage to 2dp, grade-boundary rounding) must be deterministic and match PRP-50's `resolveGrade` to avoid a card showing a grade inconsistent with its percentage.
- **Notification trigger is P6:** publish only **emits a hook + audits**; actual SMS/push/email of "results out" is PRP-54 — do not couple this PRP to a channel.
- **Shared `Student` edit:** adding the `reportCards` relation touches the `Student` model PRP-29/31/50 also extend — coordinate the migration (PRP-29 §8 hazard).
- **Rollback:** additive module + tables + two PDF templates; revert the module, drop the four tables, and drop the `Student` back-relation (coordinate). Inert until routes are registered.
