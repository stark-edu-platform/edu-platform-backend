# PRP-29 — Classes → sections → subjects + streams/electives

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P2-BE-29 (implementation-plan §P2, master-prp §5.7/§6, decision D19) · **Depends on:** PRP-28 (everything is academic-year-scoped; reuses `resolveCurrentAcademicYear`), PRP-17 (`academic.*` permissions), PRP-12 (school context / tenant scoping) · **Feeds:** PRP-30 (`TeacherAssignment` targets a `Section`×`Subject`), PRP-32 (`Enrollment` targets a `Section`; promotion maps grades), and all subject-aware P3/P4/P5 features (attendance/marks reference `Subject`/`StudentSubject`)

## 1. Problem / current state
The academic structure does not exist. There is no `Grade`/`Section`/`Subject` model, no way to map subjects to a class, and no representation of **senior-secondary streams** (Science/Commerce/Arts) or **per-student electives**. Decision **D19** is explicit: Grade (Nursery…12) → **Sections** → students; subjects mapped **per class**; teachers assigned to class-section-subject; grades 11–12 support **streams** + per-student electives, so marks/attendance/report-cards are **subject-aware** where needed.

PRP-28 established the year/term backbone; this PRP builds the structural skeleton **inside a year** that enrollment (PRP-32), teaching assignments (PRP-30), attendance (P3) and exams (P5) all hang off. Crucially, it introduces **`StudentSubject`** — the per-student subject roster (compulsory + chosen electives) that makes downstream marks/attendance subject-aware. Without it, an 11-Science student and an 11-Commerce student in the same section can't have different subject sets.

## 2. Goal & non-goals
- **Goal:** `Grade`, `Section`, `Subject`, `Stream`, `ClassSubject` (subjects offered to a grade/stream in a year), and `StudentSubject` (a student's actual subject roster for a year) models; admin CRUD under the existing `src/modules/academic/` module; a `StudentSubject` derivation service used by PRP-32 at enrollment.
- **Non-goals:** the enrollment record itself (PRP-32 owns `Enrollment`; this PRP owns the *structures* it points at), teacher assignment (PRP-30 owns `TeacherAssignment`), timetabling/periods (a P3+ attendance-config concern), marks/grading (P5), the FE screens (PRP-35). `StudentSubject` **rows** are written by PRP-32 (at enrollment) using a helper this PRP exposes — this PRP defines the model + default-derivation, not the enrollment trigger.

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```prisma
model Grade {
  gradeId   String    @id @default(uuid())
  schoolId  String
  name      String                              // "Nursery", "Class 1", … "Class 12"
  level     Int                                 // ordinal for promotion order (PRP-32): -3..12
  isSenior  Boolean   @default(false)           // 11-12: enables streams/electives (D19)
  sections  Section[]
  classSubjects ClassSubject[]
  school    School    @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@unique([schoolId, name])
  @@unique([schoolId, level])
  @@index([schoolId])
}

model Stream {
  streamId  String         @id @default(uuid())
  schoolId  String
  name      String                              // "Science" | "Commerce" | "Arts" (school-defined)
  sections  Section[]
  classSubjects ClassSubject[]
  school    School         @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt DateTime       @default(now())

  @@unique([schoolId, name])
  @@index([schoolId])
}

model Section {
  sectionId      String   @id @default(uuid())
  schoolId       String
  academicYearId String                          // year-scoped (D18/PRP-28)
  gradeId        String
  streamId       String?                         // set only for senior grades (D19)
  name           String                          // "A", "B", "Science-A"
  capacity       Int?
  classTeacherId String?                         // → UserSchool.userSchoolId (TEACHER); assignment detail in PRP-30
  grade          Grade        @relation(fields: [gradeId], references: [gradeId], onDelete: Cascade)
  stream         Stream?      @relation(fields: [streamId], references: [streamId])
  school         School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@unique([academicYearId, gradeId, streamId, name])
  @@index([schoolId])
  @@index([academicYearId])
  @@index([gradeId])
}

model Subject {
  subjectId String         @id @default(uuid())
  schoolId  String
  name      String                              // "Mathematics"
  code      String?                             // "MATH"
  classSubjects   ClassSubject[]
  studentSubjects StudentSubject[]
  school    School         @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt DateTime       @default(now())

  @@unique([schoolId, name])
  @@index([schoolId])
}

model ClassSubject {
  classSubjectId String   @id @default(uuid())
  schoolId       String
  academicYearId String                          // year-scoped offering
  gradeId        String
  streamId       String?                         // null = applies to the grade regardless of stream
  subjectId      String
  isElective     Boolean  @default(false)        // false = compulsory; true = student opts in (D19)
  grade          Grade    @relation(fields: [gradeId], references: [gradeId], onDelete: Cascade)
  stream         Stream?  @relation(fields: [streamId], references: [streamId])
  subject        Subject  @relation(fields: [subjectId], references: [subjectId], onDelete: Cascade)
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())

  @@unique([academicYearId, gradeId, streamId, subjectId])
  @@index([schoolId])
  @@index([academicYearId, gradeId])
}

model StudentSubject {
  studentSubjectId String   @id @default(uuid())
  schoolId         String
  academicYearId   String                        // per-year roster (a student's subjects can change year to year)
  studentId        String
  subjectId        String
  isElective       Boolean  @default(false)
  subject          Subject  @relation(fields: [subjectId], references: [subjectId], onDelete: Cascade)
  student          Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school           School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt        DateTime @default(now())

  @@unique([academicYearId, studentId, subjectId])
  @@index([schoolId])
  @@index([studentId, academicYearId])
}
```
Add back-relations to `School` (`grades`, `streams`, `sections`, `subjects`, `classSubjects`, `studentSubjects`) and **add `studentSubjects StudentSubject[]` to the existing `Student` model** (PRP-31 also extends `Student`; coordinate the edits — see §8). `Section.classTeacherId` / no FK to keep PRP-30's assignment model authoritative.

> **Decision — `ClassSubject` (offering) vs. `StudentSubject` (roster):** `ClassSubject` answers "what subjects does grade-11-Science offer this year?"; `StudentSubject` answers "what is *this* student actually taking?". Compulsory `ClassSubject` rows are copied into every enrolled student's `StudentSubject` automatically (PRP-32 calls the helper below); electives are added per student when they opt in. Senior-secondary subject-awareness for attendance/marks (D19) reads `StudentSubject`, not `ClassSubject`.

### 3.2 Module layout (extends `src/modules/academic/`)
Add to the module PRP-28 created (same folder, same conventions):
- `classes.routes.ts` / `classes.controller.ts` / `classes.service.ts` / `classes.schema.ts` / `classes.types.ts` — covering grades, streams, sections, subjects, class-subject mappings, and the student-subject roster derivation.
- `resolveCurrentAcademicYear` (from `academic-year.service.js`, PRP-28) defaults the `academicYearId` when a request omits it.

### 3.3 Services & routes
`classes.service.ts` exports (all `fastify`-first, all tenant-scoped via `request.schoolContext.schoolId`):
- **Grades:** `createGrade`/`listGrades`/`updateGrade` — `isSenior` toggles stream/elective eligibility.
- **Streams:** `createStream`/`listStreams` (school-defined; typically Science/Commerce/Arts).
- **Sections:** `createSection`/`listSections(academicYearId)`/`updateSection` — `streamId` allowed **only** when `grade.isSenior` (else `fastify.httpErrors.badRequest`).
- **Subjects:** `createSubject`/`listSubjects`.
- **Class-subject mapping:** `setClassSubjects(fastify, schoolId, academicYearId, gradeId, streamId?, [{ subjectId, isElective }])` — full-replace per (year, grade, stream); audited.
- **Student roster:** `deriveStudentSubjects(fastify, tx, { schoolId, academicYearId, studentId, gradeId, streamId? })` — inserts a `StudentSubject` for every **compulsory** `ClassSubject` of that (year, grade, stream); returns the created set. **Called by PRP-32 inside the enrollment transaction** (accepts a `tx` so it composes). `setStudentElectives(fastify, schoolId, academicYearId, studentId, subjectIds[])` — adds/removes elective rows, validating each chosen subject is an `isElective` `ClassSubject` for the student's grade/stream.

Routes (school-scoped subtree, `requirePermission('academic.read'|'academic.manage')`, mutations also `requireWritableSchool` PRP-15):
- Grades: `POST|GET /api/school/grades`, `PATCH /api/school/grades/:gradeId`
- Streams: `POST|GET /api/school/streams`
- Sections: `POST|GET /api/school/sections` (list takes `?academicYearId=`), `PATCH /api/school/sections/:sectionId`
- Subjects: `POST|GET /api/school/subjects`
- Class subjects: `PUT /api/school/class-subjects` (body: year/grade/stream + subject list)
- Student electives: `PUT /api/school/students/:studentId/electives`

### 3.4 Permission strings
Reuses `academic.read` / `academic.manage` from PRP-28 (no new resource) — grades/sections/subjects/streams are all "academic structure" and share the same guard. Student-elective edits use `academic.manage` (an admin/staff action); note in PRP-30 that teachers get `academic.read` only.

## 4. Implementation steps
1. **Schema:** add the six models + `School`/`Student` back-relations to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name academic_structure` then `pnpm prisma:generate`. Coordinate the `Student` edit with PRP-31 (whichever lands first adds the relation block; the other rebases).
2. **Module:** add `classes.{routes,controller,service,schema,types}.ts` to `src/modules/academic/`. Controllers thin; service `fastify`-first; enums/types from `src/generated/prisma/`.
3. **Services:** implement §3.3, especially the `deriveStudentSubjects(tx)` helper (composable into PRP-32's enrollment transaction) and the `streamId`-only-on-senior-grade guard.
4. **Routing:** register the new routes under `src/plugins/school.plugin.ts`; guard with `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on writes.
5. **Audit:** `writeAudit()` (PRP-18) on grade/stream/section/subject create, `setClassSubjects`, and `setStudentElectives`.
6. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + request/response types.

## 5. Files added / changed
- **Add:** `src/modules/academic/classes.routes.ts`, `classes.controller.ts`, `classes.service.ts`, `classes.schema.ts`, `classes.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/academic/academic-year.service.ts` (only if a shared list helper is co-located)

## 6. Acceptance criteria
- [ ] `Grade`/`Stream`/`Section`/`Subject`/`ClassSubject`/`StudentSubject` tables exist with the documented unique constraints + indexes; all carry `schoolId`; sections + class-subjects + student-subjects are year-scoped.
- [ ] A section can be created with a `streamId` only when its grade `isSenior`; otherwise `400`.
- [ ] `setClassSubjects` full-replaces the offering for a (year, grade, stream) and is idempotent.
- [ ] `deriveStudentSubjects(tx)` inserts exactly the compulsory subjects for the student's grade/stream and composes inside a caller's transaction (proven by a PRP-32-style test).
- [ ] `setStudentElectives` rejects a subject that is not an `isElective` offering for the student's grade/stream.
- [ ] All routes are tenant-scoped + permission-guarded; mutations gated by `requireWritableSchool`.
- [ ] Structure mutations are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name academic_structure` applies cleanly.
- Manual: create Class 11 (`isSenior`), a Science stream, a Science-A section; map compulsory + elective subjects; create a student → `deriveStudentSubjects` yields the compulsory set; add a valid elective; reject an invalid one (`400`).

## 8. Risks & rollback
- **Shared `Student` edit:** this PRP and PRP-31 both add relation fields to the existing `Student` model. Whichever lands first introduces the relation block; review the other's migration for a clean rebase (no duplicate field). Call this out in the PR.
- **Offering vs. roster drift:** if a `ClassSubject` is removed after students have `StudentSubject` rows, the roster rows persist (history). Document that `setClassSubjects` does **not** retroactively delete student rosters — roster cleanup, if ever needed, is an explicit admin action (not in scope).
- **Stream optionality:** `Section.streamId`/`ClassSubject.streamId` are nullable so non-senior grades work unchanged; queries must treat `null` stream as "applies to all" — encode that in the resolver, not ad-hoc per call site.
- **Promotion coupling (PRP-32):** `Grade.level` is the ordinal promotion uses; keep it unique per school and contiguous enough that "next grade" is unambiguous (PRP-32 maps `level → level+1`).
- Rollback: additive module + tables; revert the module, drop the six tables, and remove the `Student.studentSubjects` relation (coordinate with PRP-31 if both shipped).
