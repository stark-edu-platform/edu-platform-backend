# PRP-49 — Exam types, exam scheduling & admit cards

> **Status:** Proposed · **Phase:** 5 · **Severity:** 🟠 Med · **Size:** L
> **Depends on:** PRP-28 (academic year + terms — every exam is year-scoped and tied to a `Term`), PRP-29 (`Grade`/`Section`/`Subject`/`ClassSubject`/`StudentSubject` — a schedule is per `Section`×`Subject`, subject-aware via `StudentSubject`), PRP-32 (`Enrollment` — admit cards are issued to the section's enrolled students), PRP-46 (the **canonical** server-side PDF + storage service — `src/modules/pdf/pdf.service.ts`'s `renderPdf({ template, data })` and `src/lib/storage/`; this PRP consumes it and only adds an `admit-card` template, it does **not** stand up a PDF library), PRP-12 (school context / tenant scoping the routes layer on), PRP-17 (RBAC — new `exam.*` permission strings), PRP-15 (`requireWritableSchool` — exam config is a write), PRP-18 (audit on exam create/schedule/publish) · **Feeds:** PRP-50 (`MarksEntry` hangs off an `Exam` + `ExamSchedule`), PRP-51 (report cards aggregate marks across a term's exams), PRP-52 (FE exam-setup screens), PRP-53 (FE result/admit-card viewing)

## 1. Problem / current state
The platform has **no concept of an exam, an exam timetable, or an admit card / hall ticket**. Phase 2 establishes the academic backbone — `AcademicYear`/`Term` (PRP-28), `Grade`/`Section`/`Subject`/`ClassSubject`/`StudentSubject` (PRP-29), per-year `Enrollment` (PRP-32) — but nothing models an **assessment event** against that structure. Decision **D18** ties exams to **terms** (CBSE 2-term / 3-trimester / 4-quarter), and **D19** makes assessment **subject-aware** (senior-secondary students in the same section sit different papers per their `StudentSubject` roster). Master-prp §5.7 lists `ExamType`, `Exam`, `ExamSchedule` as the P5 entities; §6 (P5) lists "Exam scheduling … admit cards" as headline deliverables.

This PRP owns the **scheduling half** of P5: what exams exist, when each subject's paper is, and the **admit-card / hall-ticket PDF** a student carries into the exam hall. It is the first of three P5 backend PRPs — PRP-50 adds grading + marks entry against these exams, PRP-51 adds report cards + result publishing.

There is **no school-scoped module for exams** yet. Server-side PDF generation, however, **already exists**: **PRP-46 (P4 receipts) is the canonical owner** of `src/modules/pdf/pdf.service.ts` (`renderPdf({ template, data }) → Buffer`) and the `src/lib/storage/` object store. This PRP does **not** introduce a PDF library — it **consumes PRP-46's renderer** and adds **only** an `admit-card` template to the shared `src/modules/pdf/templates/` directory (PRP-51 likewise adds report-card/marksheet templates to the same place). One renderer, one storage lib, many templates.

## 2. Goal & non-goals
- **Goal:** `ExamType`, `Exam`, `ExamSchedule` models (+ a `ExamStatus` enum); a `src/modules/exam/` module (house split) with admin/staff CRUD for exam types, exams (per year + term, targeting one or more grades/sections), and per-subject schedule rows (date/time/room/max-marks); an **admit-card / hall-ticket PDF** endpoint that renders a student's per-exam timetable **via PRP-46's canonical `renderPdf({ template, data })`** (adding only an `admit-card` template — no new PDF library); and the `exam.*` permission strings (added to PRP-17's matrix).
- **Non-goals:** grading schemes + marks entry (PRP-50 — schedules carry `maxMarks`/`passMarks` so marks validate against them, but no `MarksEntry` here), report cards / marksheets / result publishing / merit lists (PRP-51), the FE exam-setup UI (PRP-52), the FE admit-card download UI (PRP-53), invigilation/seating-plan allocation and OMR/online-exam delivery (out of scope for v1 — `room`/`seatNo` are free-text fields, no allocation engine), timetable-clash *auto-resolution* (we **detect** a clash and warn/reject; we do not auto-reschedule).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Import enums from `src/generated/prisma/enums.js`; every child row denormalizes `schoolId` (house convention, mirrors `Section`/`StudentSubject` in PRP-29). All exam data is **year-scoped** (`academicYearId`) and term-linked (`termId`) per D18.

```prisma
enum ExamStatus {
  DRAFT        // being configured; schedule editable, not visible to students/parents
  SCHEDULED    // timetable published; admit cards issuable; marks not yet open
  ONGOING      // exam window in progress (marks entry opens — PRP-50)
  COMPLETED    // all papers done; results pending publish (PRP-51)
  PUBLISHED    // results released (set by PRP-51 publish; kept here so the lifecycle is one enum)
  CANCELLED    // called off; schedules retained for history
}

// A reusable, school-defined category of assessment (e.g. "Unit Test", "Half-Yearly",
// "Final", "Pre-Board"). Configurable weightage feeds PRP-51 term aggregation (⚠︎ O-P5).
model ExamType {
  examTypeId   String   @id @default(uuid())
  schoolId     String
  name         String                              // "Unit Test 1", "Half-Yearly", "Annual"
  code         String?                             // "UT1", "HY", "ANN"
  weightage    Decimal? @db.Decimal(5, 2)          // % this type contributes to the term total (⚠︎ O-P5; nullable until policy set)
  isScholastic Boolean  @default(true)             // false → co-scholastic (graded on scales, not marks) — PRP-50/51
  exams        Exam[]
  school       School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
}

// A concrete assessment event in a year+term, targeting one or more grades.
model Exam {
  examId         String       @id @default(uuid())
  schoolId       String
  academicYearId String                            // year-scoped (PRP-28)
  termId         String                            // term-aligned (D18)
  examTypeId     String
  name           String                            // display label, defaults from type ("Half-Yearly 2026-27")
  status         ExamStatus   @default(DRAFT)
  startDate      DateTime                           // exam window (papers fall within)
  endDate        DateTime
  schedules      ExamSchedule[]
  examType       ExamType     @relation(fields: [examTypeId], references: [examTypeId])
  school         School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([schoolId])
  @@index([academicYearId, termId])
  @@index([status])
}

// One paper: a (grade [+ optional stream] × subject) sitting at a date/time.
// Marks (PRP-50) reference an ExamSchedule, so maxMarks/passMarks live here.
model ExamSchedule {
  examScheduleId String   @id @default(uuid())
  schoolId       String
  examId         String
  gradeId        String                            // which grade sits this paper (PRP-29)
  streamId       String?                           // senior-secondary: stream-specific paper (D19); null = all streams
  subjectId      String                            // PRP-29 Subject
  examDate       DateTime
  startTime      String                            // "09:30" (local wall-clock; see §3.6 TZ note)
  durationMins   Int
  maxMarks       Decimal  @db.Decimal(6, 2)
  passMarks      Decimal  @db.Decimal(6, 2)
  room           String?                           // free-text; no seating engine in v1
  exam           Exam     @relation(fields: [examId], references: [examId], onDelete: Cascade)
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([examId, gradeId, streamId, subjectId])  // one paper per subject per grade/stream in an exam
  @@index([schoolId])
  @@index([examId])
  @@index([gradeId, subjectId])
}
```
Add back-relations to `School` (`examTypes`, `exams`, `examSchedules`). `gradeId`/`streamId`/`subjectId` reference PRP-29 models — prefer explicit relations and coordinate the PRP-29 inverse-relation edit (same pattern PRP-30 §8 flags for `TeacherAssignment`), or keep loose indexed FKs to avoid a circular edit; decide in review.

> **Decision — schedule is `Grade(+Stream)×Subject`, not `Section×Subject`:** a paper is the same across all sections of a grade (Class-10-A and Class-10-B sit the same Maths paper at the same time), so the schedule keys on `gradeId` (+ optional `streamId` for senior-secondary stream papers, D19), **not** `sectionId`. Marks (PRP-50) are still per **student** (resolved to their section + `StudentSubject`), so section-level granularity lives at the marks layer, not the schedule layer. This also keeps the timetable compact.

> **Decision — subject-awareness via `StudentSubject` (D19):** which students appear on an admit card / are eligible for a paper is **not** "everyone in the grade" — it is everyone whose `StudentSubject` (PRP-29) for that year includes the paper's `subjectId`. A Class-11-Science student's admit card lists Physics/Chem/Maths; a Class-11-Commerce student's lists Accountancy/Business/Economics, even in adjacent sections. The admit-card builder (§3.4) intersects the exam's schedules with the student's `StudentSubject` roster.

### 3.2 Module layout (`src/modules/exam/`)
New school-scoped feature module, following the house split exactly and registered under PRP-12's school-scoped plugin (`src/plugins/school.plugin.ts`), mirroring how PRP-28/29 register `src/modules/academic/`:
- `exam.routes.ts` — wiring + Fastify schemas (exam types, exams, schedules, admit-card).
- `exam.controller.ts` — thin HTTP in/out; calls services; returns `successResponse`.
- `exam.service.ts` — Prisma access + the validations/transitions in §3.3 (`fastify` first arg, scoped by `request.schoolContext.schoolId`).
- `exam.schema.ts` — Fastify JSON schemas, `successEnvelope` style copied from `src/modules/developer/developer.schema.ts` / PRP-28's `academic-year.schema.ts`.
- `exam.types.ts` — `CreateExamTypeBody`, `CreateExamBody`, `ConfigureSchedulesBody`, `AdmitCardParams`, list/response item types; enums from `src/generated/prisma/enums.js`.

### 3.3 Services & routes
`exam.service.ts` exports (all `fastify`-first, all tenant-scoped via `request.schoolContext.schoolId` — never a client-supplied `schoolId`, per PRP-12; `academicYearId` defaults via `resolveCurrentAcademicYear` from `src/modules/academic/academic-year.service.js`, PRP-28):
- **Exam types:** `createExamType` / `listExamTypes` / `updateExamType` — `weightage`/`isScholastic` set here (⚠︎ O-P5, see §6).
- **Exams:** `createExam(fastify, schoolId, { academicYearId?, termId, examTypeId, name?, startDate, endDate })` — validates `termId` belongs to the (school, year) (PRP-28), `startDate < endDate`, and the window sits inside the term window; defaults `name` from the exam type; creates `status: DRAFT`. `listExams({ academicYearId?, termId?, status? })`, `getExam` (with schedules).
- **Schedules:** `configureSchedules(fastify, schoolId, examId, [{ gradeId, streamId?, subjectId, examDate, startTime, durationMins, maxMarks, passMarks, room? }])` — full-replace per exam in a transaction; validates each `subjectId` is a `ClassSubject` of that grade/stream for the year (PRP-29), `passMarks ≤ maxMarks`, each `examDate` inside the exam window, and `streamId` only when `grade.isSenior`. **Clash detection:** rejects (or, configurably, warns) two papers for the **same grade** that overlap in date+time (`fastify.httpErrors.conflict('Timetable clash: <grade> has two papers at <time>')`). Idempotent (full replace).
- **Lifecycle transition:** `transitionExam(fastify, schoolId, examId, action)` for `publish-schedule` (DRAFT→SCHEDULED, requires ≥1 schedule), `start` (SCHEDULED→ONGOING), `complete` (ONGOING→COMPLETED), `cancel` (→CANCELLED). The `COMPLETED→PUBLISHED` transition is driven by **PRP-51** (result publish) but lives on this same enum so the lifecycle is single-sourced. Each transition is audited (`writeAudit`, PRP-18, e.g. `action: 'exam.schedule_published'`).
- **Admit card:** `getAdmitCardData(fastify, schoolId, examId, studentId)` — resolves the student's `Enrollment` (PRP-32) for the exam's year → their `gradeId`/`streamId`/`sectionId`, intersects the exam's `ExamSchedule` rows with the student's `StudentSubject` roster (PRP-29, D19), and returns `{ school, student, exam, papers[] }` ready for the renderer. `generateAdmitCardPdf(fastify, schoolId, examId, studentId) → Buffer` calls the §3.5 renderer. A bulk variant `generateSectionAdmitCardsPdf(examId, sectionId)` concatenates a section's cards for office printing.

Routes (registered in the school-scoped subtree, each guarded with `requirePermission`, PRP-17; mutations also opt into `fastify.requireWritableSchool`, PRP-15):
- Exam types: `POST|GET /api/school/exam-types` (`exam.manage`/`exam.read`), `PATCH /api/school/exam-types/:examTypeId` (`exam.manage`)
- Exams: `POST|GET /api/school/exams` (`exam.manage`/`exam.read`), `GET /api/school/exams/:examId` (`exam.read`), `POST /api/school/exams/:examId/:action` (`exam.manage`)
- Schedules: `PUT /api/school/exams/:examId/schedules` (`exam.manage`)
- Admit card: `GET /api/school/exams/:examId/admit-card/:studentId` (`exam.read` — admin/staff/teacher; a parent/student fetching **their own** card is gated by an ownership check in the service, see §3.7) → `application/pdf`
- Bulk admit cards: `GET /api/school/exams/:examId/admit-cards?sectionId=` (`exam.manage`) → `application/pdf`

### 3.4 Admit-card / hall-ticket content
The hall ticket renders (template-driven, see §3.5): school header (name/subdomain/board/logo placeholder), student block (name, admission no., class+section, roll no. if present, photo placeholder), exam block (exam name, term, year), and a **per-paper table** (subject, date, day, time, duration, room) — **only the subjects the student actually sits** (their `StudentSubject` intersection), plus an instructions footer and a signature line. ⚠︎ The exact hall-ticket layout/fields are **not finalized (O-P5 — report-card/template question)**; the renderer is template-driven so the layout is data/config, not hard-coded (see §3.5 + §6).

### 3.5 Server-side PDF — consume PRP-46's canonical renderer
The PDF engine is **not** introduced here. **PRP-46 owns `src/modules/pdf/pdf.service.ts` and the `src/lib/storage/` object store**; this PRP reuses them and adds one template:
- **Renderer (reused):** call PRP-46's canonical **object-arg** `renderPdf({ template: 'admit-card', data }) → Buffer`. Do **not** add a PDF dependency, and do **not** introduce a `src/utils/pdf/render.ts` or a positional `renderPdf(template, data)` — there is exactly one renderer (PRP-46's) with the object-arg signature, called everywhere.
- **New template only:** add `src/modules/pdf/templates/admit-card.*` to PRP-46's shared template directory + registry (alongside `receipt`). The admit-card template is the **only** new PDF artifact this PRP contributes. Controllers stream the buffer with `reply.type('application/pdf').header('Content-Disposition', ...).send(buffer)`.
- **Off the hot path:** generation is synchronous-per-request for a single card (fast); the **bulk** section variant should be size-bounded and, if heavy, deferred to a job (reuse PRP-05's job/script pattern) — flagged, not built here.
- **Assets/storage:** the school logo / student photo are referenced via PRP-46's `src/lib/storage/` (master-prp §5.6); v1 uses placeholders if no asset is uploaded yet — do **not** block admit cards on file storage.

### 3.6 Permission strings (extends PRP-17 §3.4)
Append to the canonical list in `src/modules/authz/permissions.ts` (PRP-17 owns that file; this PRP adds rows + the matrix line). A teacher reads exams (to know the timetable) but does not configure them; marks-entry rights are a **separate** `marks.*` resource owned by PRP-50.

| Resource | Actions (P5) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `exam` | `read`, `manage` | read+manage | read+manage | read | read (own admit card §3.7) | read (children's admit card §3.7) |

### 3.7 Ownership for student/parent admit-card access
`exam.read` lets a STUDENT/PARENT hit the admit-card route, but the **service** must enforce that a STUDENT can only fetch their own card and a PARENT only their linked children's. Encode this "own/children" filter in `getAdmitCardData` (matching PRP-30's "teacher sees only own assignments" pattern — the matrix grants the verb, the service scopes the rows), not in the permission matrix. For the parent path, reuse **PRP-41's `resolveParentChildren(fastify, parentUserId, { schoolId })`** (the single guardian-edge authorization gate — a `studentId` not in the caller's linked children → `403/404`) rather than re-implementing the `ParentStudent` join, so the link rule stays single-sourced with PRP-41/PRP-51.

## 4. Implementation steps
1. **Schema:** add `ExamStatus`, `ExamType`, `Exam`, `ExamSchedule` + the three `School` back-relations to `prisma/schema.prisma`; coordinate the PRP-29 inverse-relation edit for `Grade`/`Stream`/`Subject` (or keep loose FKs). `pnpm exec prisma migrate dev --name exams_and_scheduling` then `pnpm prisma:generate`.
2. **Module:** add `src/modules/exam/{routes,controller,service,schema,types}.ts` following the module split (controllers thin; service `fastify`-first). Import enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Services:** implement §3.3 — `createExam` (term-window validation), `configureSchedules` (`ClassSubject` validation + clash detection + `passMarks ≤ maxMarks`), `transitionExam`, and the admit-card resolver intersecting `ExamSchedule` × `StudentSubject`. Use `fastify.httpErrors.*` on all error paths; default the year via `resolveCurrentAcademicYear` (PRP-28).
4. **PDF template (reuse PRP-46):** add **only** `src/modules/pdf/templates/admit-card.*` to PRP-46's shared template directory + registry and render via PRP-46's `renderPdf({ template: 'admit-card', data })`. **No** new `package.json` PDF dependency and **no** `src/utils/pdf/` — PRP-46 already provides the renderer + storage.
5. **Routing + guards:** register `exam.routes.ts` under `src/plugins/school.plugin.ts`; guard each route with `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; enforce the student/parent ownership filter in the admit-card service (§3.7).
6. **Permissions:** add the `exam.read`/`exam.manage` rows + matrix entries to `src/modules/authz/permissions.ts` (PRP-17) and re-run `pnpm seed:permissions`.
7. **Audit:** `writeAudit()` (PRP-18) on exam-type/exam create, `configureSchedules`, and every `transitionExam`.
8. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + request/response types; the admit-card route declares an `application/pdf` response (not the JSON envelope) — document this exception in the schema.

## 5. Files added / changed
- **Add:** `src/modules/exam/exam.routes.ts`, `exam.controller.ts`, `exam.service.ts`, `exam.schema.ts`, `exam.types.ts`; `src/modules/pdf/templates/admit-card.*` (a new template in PRP-46's shared PDF module — **no** new PDF library/util)
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `exam.*`), `src/modules/pdf/pdf.registry.ts` (register the `admit-card` template — PRP-46's registry), and the PRP-29 academic models if explicit inverse relations are added for `Grade`/`Stream`/`Subject`

## 6. Acceptance criteria
- [ ] `ExamType`/`Exam`/`ExamSchedule` tables exist with the documented unique constraints + indexes; all carry `schoolId`; exams are year-scoped + term-linked.
- [ ] Creating an exam validates `termId` belongs to the (school, year) and the window sits inside the term window; the exam starts `DRAFT`.
- [ ] `configureSchedules` rejects a paper whose subject is not a `ClassSubject` of the grade/stream (PRP-29), a `passMarks > maxMarks`, a paper outside the exam window, a `streamId` on a non-senior grade, and a same-grade timetable clash.
- [ ] `transitionExam` enforces the lifecycle (DRAFT→SCHEDULED requires ≥1 schedule; SCHEDULED→ONGOING→COMPLETED; →CANCELLED), and each transition is audited (PRP-18).
- [ ] The admit-card endpoint returns a PDF listing **only the subjects the student actually sits** (their `StudentSubject` intersection, D19); a Class-11-Science vs. Class-11-Commerce student get different paper lists.
- [ ] A STUDENT/PARENT can fetch only their own / their children's admit card (service-side ownership check); an ADMIN/STAFF can fetch any and a section in bulk.
- [ ] All routes are tenant-scoped (client-supplied `schoolId` ignored) + permission-guarded; mutations 403/402 on a non-writable school (PRP-15).
- [ ] ⚠︎ The O-P5 assumptions (`ExamType.weightage`/`isScholastic`, admit-card template) are recorded inline and the PDF renderer is template-driven (no hard-coded board layout).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name exams_and_scheduling` applies cleanly; `pnpm seed:permissions` adds `exam.*`.
- Manual: create an exam type → create a Half-Yearly exam in the current term → configure schedules for Class 10 (Maths/Science/…) and Class 11 Science (Physics/Chem/Maths); attempt a same-grade clash → `409`; publish the schedule → SCHEDULED; fetch an admit card for an 11-Science student and confirm only their `StudentSubject` papers appear; fetch as that student's parent (allowed) and as an unrelated parent (denied).

## 8. Risks & rollback
- **Subject-awareness is the correctness crux (D19):** the admit card / eligibility **must** intersect `ExamSchedule` with `StudentSubject`, not list the whole grade — otherwise a Commerce student gets a Physics hall ticket. Cover the senior-secondary case with a test (an 11-Science and an 11-Commerce student in adjacent sections).
- **Cross-PRP relation edits (PRP-29):** `ExamSchedule` references `Grade`/`Stream`/`Subject`; adding inverse relations touches PRP-29's models (same hazard PRP-30 §8 flags). Land PRP-29 first; add inverse relations here or keep loose indexed FKs — decide in review.
- **PDF is reused, not greenfield:** the renderer is **PRP-46's** canonical `renderPdf({ template, data }) → Buffer` (object-arg) — this PRP adds only the `admit-card` template, and PRP-51 likewise adds report-card/marksheet templates to the same module. Do **not** add a second PDF library or a `src/utils/pdf/` path. Keep heavy/bulk generation off the request path (defer to a PRP-05-style job if it grows).
- **Timezone/wall-clock:** `examDate` is a timestamp (UTC) but `startTime` is a wall-clock string (an exam "starts at 09:30 local" regardless of server TZ) — do not combine them into a single UTC instant without the school's TZ; v1 stores them separately and the renderer prints the wall-clock as-is. Date-window validation compares date parts in UTC (same rule as PRP-28's term windows).
- **Decimal for marks:** `maxMarks`/`passMarks`/`weightage` use Prisma `Decimal`; never float (consistent with PRP-15's money rule and PRP-50's marks).
- **⚠︎ O-P5 dependencies:** `weightage` (term contribution) and `isScholastic` shape PRP-51's aggregation but the **policy** is open (O-P5: term weightage, grade bands). They are nullable/defaulted and carried as assumptions; PRP-50/51 consume them once O-P5 resolves.
- **Rollback:** additive module + tables + the one `admit-card` template added to PRP-46's PDF module; revert the module, drop the three tables (additive migration), and remove the `admit-card` template/registry entry. PRP-46's PDF service is untouched.
