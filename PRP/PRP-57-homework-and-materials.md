# PRP-57 — Homework / assignments, study materials & syllabus tracking

> **Status:** Proposed · **Phase:** 6 · **Severity:** 🟠 Med · **Size:** XL
> **Addresses:** P6-BE-4 (master-prp §6 P6, §5.7 P6) · **Depends on:** PRP-29 (`Grade`/`Section`/`Subject`/`ClassSubject` — homework/materials/syllabus are per-class-subject), PRP-32 (`Enrollment` — who is in the section, i.e. who a homework is assigned to / who may submit), PRP-30 (`TeacherAssignment` — which teacher owns a class-subject), PRP-46 (the **canonical** `src/lib/storage/` S3 abstraction + `STORAGE_*` env — homework/submission/material files use it; **no** parallel storage util/env), PRP-28 (academic-year scoping), PRP-12 (school context), PRP-18 (`writeAudit()`), PRP-17 (permission keys) · **Notifies via:** PRP-54 (`homework.assigned` / `homework.graded` fan-out — optional but recommended) · **Consumed by:** FE PRP-59 (web homework/materials/syllabus UI), MOB PRP-60 (mobile homework)

## 1. Problem / current state
There is **no academic engagement layer**: teachers cannot post **homework/assignments** for a class, students cannot **submit**, teachers cannot **grade** submissions, there is no place for **study materials** (notes/PDFs/links shared per subject), and there is no **syllabus tracking** (the chapter/topic plan and how much has been covered). Master-prp §6 (P6) lists "homework/assignments, study materials/syllabus" and §5.7 names `Homework`, `StudyMaterial`, `Syllabus` for P6.

P2 provides the academic structure this hangs off: PRP-29 (`ClassSubject` — a subject taught in a section), PRP-30 (`TeacherAssignment` — the owning teacher), PRP-32 (`Enrollment` — the students in the section). This PRP adds the three features as per-class-subject, year-scoped entities, following the BE module split, `successResponse`/`errorResponse`, Prisma-types-from-`src/generated/prisma/`, and write-gating (PRP-15). New-homework and graded notifications fan out through PRP-54.

⚠︎ **O-P6 (master-prp §10):** the **template catalog** is open — `homework.assigned`/`homework.graded` templates are seeded into PRP-54's catalog and refined as O-P6 resolves. Submission **file storage** uses the cross-cutting S3 service (master-prp §5.6).

## 2. Goal & non-goals
- **Goal:** (a) **`Homework`** — a teacher posts an assignment to a `ClassSubject` (title, instructions, optional attachments, due date, optional max marks), targeted at a section's enrolled students (PRP-32); (b) **`HomeworkSubmission`** — a student (or parent on their behalf — D17) submits (text + S3 attachments) before/after due, with a status (`ASSIGNED`→`SUBMITTED`→`GRADED`/`RETURNED`/`LATE`); the teacher **grades** (marks + feedback) and returns; (c) **`StudyMaterial`** — a teacher shares materials (file or link) per `ClassSubject`/topic, visible to that class; (d) **`SyllabusUnit`** — a per-`ClassSubject` chapter/topic plan with a **covered/in-progress/planned** status + % progress, so admins/parents see coverage; (e) **read APIs** scoped per role (teacher: their class-subjects; student/parent: the child's enrolled class-subjects); (f) fan-out via PRP-54 on assign + grade.
- **Non-goals:** the notification engine (PRP-54); exam/marks (`MarksEntry` is PRP-50 — homework marks are **formative/assignment** scores, not report-card marks, though a future link is possible — note it, don't build it); plagiarism detection / auto-grading (out of scope); a rich quiz/MCQ engine (v1 homework is instructions + file/text submission, not auto-graded questions — flag as a possible follow-up); the web/mobile UI (PRP-59/PRP-60); a generic LMS course structure (this is K-12 class-subject scoped, not college courses — master-prp §2 non-goal); messaging about homework (that's PRP-56).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`) — per class-subject, year + tenant scoped
```
enum HomeworkStatus { DRAFT PUBLISHED CLOSED }
enum SubmissionStatus { ASSIGNED SUBMITTED LATE GRADED RETURNED }
enum MaterialKind { FILE LINK }
enum SyllabusStatus { PLANNED IN_PROGRESS COVERED }

model Homework {
  homeworkId      String        @id @default(uuid())
  schoolId        String
  academicYearId  String
  classSubjectId  String                                    // PRP-29 (section × subject)
  sectionId       String                                    // denormalized for scoping/roster
  subjectId       String
  teacherUserId   String                                    // author/owner (PRP-30 assignment)
  title           String
  instructions    String
  dueAt           DateTime?
  maxMarks        Float?                                     // optional formative score
  status          HomeworkStatus @default(DRAFT)
  publishedAt     DateTime?
  attachments     HomeworkAttachment[]
  submissions     HomeworkSubmission[]
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  @@index([schoolId, academicYearId, classSubjectId])
  @@index([sectionId, dueAt])
}

model HomeworkAttachment {
  homeworkAttachmentId String   @id @default(uuid())
  homeworkId           String
  schoolId             String
  fileKey              String                               // S3 (master-prp §5.6)
  fileName             String
  contentType          String?
  homework             Homework @relation(fields: [homeworkId], references: [homeworkId], onDelete: Cascade)
  @@index([homeworkId])
}

model HomeworkSubmission {
  homeworkSubmissionId String           @id @default(uuid())
  homeworkId           String
  schoolId             String
  studentId            String                               // the student it's for (PRP-32 enrollment)
  submittedByUserId    String?                              // student or guardian (D17)
  body                 String?
  attachmentKey        String?                              // S3 (single file in v1; or a child attachment table)
  attachmentName       String?
  status               SubmissionStatus @default(ASSIGNED)
  marksAwarded         Float?
  feedback             String?
  submittedAt          DateTime?
  gradedAt             DateTime?
  gradedByUserId       String?
  homework             Homework         @relation(fields: [homeworkId], references: [homeworkId], onDelete: Cascade)
  @@unique([homeworkId, studentId])                         // one submission record per student per homework
  @@index([schoolId, studentId])
  @@index([homeworkId, status])
}

model StudyMaterial {
  studyMaterialId String       @id @default(uuid())
  schoolId        String
  academicYearId  String
  classSubjectId  String
  sectionId       String
  subjectId       String
  teacherUserId   String
  title           String
  description     String?
  kind            MaterialKind @default(FILE)
  fileKey         String?                                   // when FILE (S3)
  fileName        String?
  url             String?                                   // when LINK
  topic           String?                                   // optional link to a SyllabusUnit topic
  createdAt       DateTime     @default(now())
  @@index([schoolId, academicYearId, classSubjectId])
}

model SyllabusUnit {
  syllabusUnitId  String         @id @default(uuid())
  schoolId        String
  academicYearId  String
  classSubjectId  String
  subjectId       String
  sectionId       String?                                   // null = grade-level plan; non-null = per-section progress
  unitNo          Int                                       // ordering
  title           String                                    // chapter/topic
  description     String?
  status          SyllabusStatus @default(PLANNED)
  progressPct     Int            @default(0)                // 0–100 coverage
  plannedDate     DateTime?
  completedDate   DateTime?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  @@index([schoolId, academicYearId, classSubjectId, unitNo])
}
```
A `HomeworkSubmission` row may be **lazily created** (created on first student submit) or **pre-seeded** for every enrolled student at publish (so a teacher sees "not submitted" rows). v1: pre-seed `ASSIGNED` rows at publish for the section's enrollment (PRP-32) so the teacher's grading grid lists everyone — documented; the `@@unique` keeps it one per student.

### 3.2 Lifecycle & scoping
- **Homework:** `DRAFT` → `PUBLISHED` (visible to the section's students/guardians; optional fan-out) → `CLOSED` (no more submissions). Publishing pre-seeds `HomeworkSubmission` `ASSIGNED` rows for current enrollment. Submitting flips a row to `SUBMITTED` (or `LATE` if past `dueAt`); grading sets `marksAwarded`/`feedback`/`gradedAt` → `GRADED`, and `RETURNED` when released to the student.
- **Scoping (server-side, PRP-12):** a **teacher** sees/manages homework/materials/syllabus for **their** `ClassSubject`s (PRP-30 `TeacherAssignment`); a **student** sees homework/materials for the class-subjects of **their** enrollment (PRP-32) and only **their own** submission; a **parent** sees their child's homework + submissions (D17, via PRP-31); an **admin** sees all in the school. The visibility predicate (teacher-assignment ∪ student-enrollment ∪ guardian-of) lives in one helper, reused across the three features.

### 3.3 Fan-out (PRP-54)
- **`homework.assigned`** on publish → recipients = the section's students + guardians (PRP-32/31); `category: 'HOMEWORK'`; `variables` include `entityType: 'homework'`, `entityId: homeworkId`; `dedupeKey: \`homework.assigned:${homeworkId}\``. The `dedupeKey` is **per logical event**, **not** per recipient — PRP-54's `DeliveryLog` `@@unique([dedupeKey, userId, channel])` adds `userId`, so the one key fans out to every student+guardian (one row apiece) and de-dupes only a replay to the same recipient (don't append `userId` here). `IN_APP` always; PUSH/EMAIL per pref. Fire-and-forget.
- **`homework.graded`** on return → recipient = the submitting student + guardians; `variables` include `entityType: 'submission'`, `entityId: submissionId`; `dedupeKey: \`homework.graded:${submissionId}\`` (per-event; `userId` is added by PRP-54's unique). `entityType`/`entityId` drive the push/feed deep-link (PRP-54 §3.4b).
- Materials/syllabus changes do **not** fan out by default (too noisy) — optional per-school setting later. Reuse PRP-55's recipient-resolution helper (section → students + guardians) so the logic isn't duplicated.

### 3.4 APIs (`src/modules/homework/…`, `src/modules/study-material/…`, `src/modules/syllabus/…`)
Under PRP-12's school plugin, `schoolId` forced; writes via PRP-15 `requireWritableSchool`; `successResponse`/`errorResponse`.
| Method & path | Guard | Purpose |
|---|---|---|
| `GET /school/homework?classSubjectId=&sectionId=&status=&cursor=` | `homework.read` | list (scoped by role per §3.2) |
| `GET /school/homework/:id` | `homework.read` | one homework (+ attachments; for a student, their own submission) |
| `POST /school/homework` / `PUT /:id` | `homework.manage` + writable | teacher create/edit (own class-subject) |
| `POST /school/homework/:id/publish` | `homework.manage` + writable | publish → pre-seed submissions + fan-out |
| `POST /school/homework/:id/submissions` | `homework.submit` + writable | student/guardian submit (text + S3 attachment) |
| `GET /school/homework/:id/submissions` | `homework.grade` | teacher's grading grid (all enrolled, with status) |
| `PUT /school/homework/:id/submissions/:sid/grade` | `homework.grade` + writable | grade + feedback → `homework.graded` fan-out |
| `GET /school/materials?classSubjectId=&cursor=` | `material.read` | list materials (scoped) |
| `POST /school/materials` / `PUT /:id` / `DELETE /:id` | `material.manage` + writable | teacher material CRUD (file presign or link) |
| `GET /school/syllabus?classSubjectId=` | `syllabus.read` | the unit plan + coverage for a class-subject |
| `POST /school/syllabus` / `PUT /:id` (status/progress) / `DELETE /:id` | `syllabus.manage` + writable | teacher syllabus CRUD + mark coverage |

New permission keys: `homework.read`, `homework.manage`, `homework.submit`, `homework.grade`, `material.read`, `material.manage`, `syllabus.read`, `syllabus.manage` — added to PRP-17's seed map (FE PRP-59 mirrors them). `homework.submit` → STUDENT/PARENT; `homework.manage`/`grade`/`material.manage`/`syllabus.manage` → TEACHER/ADMIN; the `*.read` keys span the relevant roles.

### 3.5 Attachments (S3 via PRP-46's `src/lib/storage/`, master-prp §5.6)
Homework attachments, submission files, and `FILE` materials are S3 objects served through **PRP-46's canonical `src/lib/storage/`** (`putObject`/`getSignedUrl`) + its `STORAGE_*` env — the **same** storage lib PRP-55/56 use, **no** parallel storage util/env. Presigned upload init + short-lived presigned GET gated by the same visibility predicate. Same pattern as PRP-55 (store `fileKey`/metadata only; never expose raw bucket paths; a non-member must not fetch a submission file).

### 3.6 Audit (PRP-18)
`writeAudit` on `homework.publish`, `homework.grade`, `material.delete`, `syllabus.update` (identifiers + summary; **no instructions/feedback bodies** — PRP-18 PII rule). Submissions themselves are high-volume → not audited (the row + `DeliveryLog` are the record).

## 4. Implementation steps
1. **Schema:** add `Homework`/`HomeworkAttachment`/`HomeworkSubmission`/`StudyMaterial`/`SyllabusUnit` + the four enums to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name homework_materials_syllabus` then `pnpm prisma:generate`.
2. **Homework module:** `src/modules/homework/{routes,controller,service,schema,types}.ts` — CRUD + publish (pre-seed submissions from PRP-32 enrollment) + submit + grading grid + grade; the role-visibility predicate; wire `homework.assigned`/`homework.graded` fan-out (PRP-54), fire-and-forget.
3. **Study-material module:** `src/modules/study-material/{routes,controller,service,schema,types}.ts` — file/link CRUD, S3 presign for FILE.
4. **Syllabus module:** `src/modules/syllabus/{routes,controller,service,schema,types}.ts` — unit CRUD + status/progress updates + coverage rollup.
5. **Attachments:** S3 presign init + gated GET via **PRP-46's `src/lib/storage/`** (same as PRP-55/56; no new storage util/env) for homework attachments, submission files, materials.
6. **Permissions:** add the eight keys to PRP-17's seed map.
7. **Notification templates:** seed `homework.assigned`/`homework.graded` into PRP-54's catalog ⚠︎ (O-P6).
8. **Register + schemas:** register the three modules under PRP-12's school plugin; Fastify JSON schemas + Swagger.

## 5. Files added / changed
- **Add:** `src/modules/homework/{routes,controller,service,schema,types}.ts`, `src/modules/study-material/{routes,controller,service,schema,types}.ts`, `src/modules/syllabus/{routes,controller,service,schema,types}.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), PRP-17's permission seed (eight keys), PRP-12's school plugin registration, PRP-54's template catalog seed (`homework.assigned`/`homework.graded`); **consumes** PRP-46's `src/lib/storage/` for attachments (no new storage util/env)

## 6. Acceptance criteria
- [ ] The five models + four enums exist, per-class-subject, year- and tenant-scoped (PRP-29/28/12), with the documented uniques/indexes.
- [ ] A teacher can create + publish homework to one of **their** class-subjects (PRP-30); publishing pre-seeds an `ASSIGNED` submission row per enrolled student (PRP-32) and fans out `homework.assigned` (PRP-54) to students + guardians.
- [ ] A student/guardian submits (text + S3 file) → status `SUBMITTED` (or `LATE` past `dueAt`); the teacher's grading grid lists every enrolled student with status; grading sets marks + feedback and fans out `homework.graded` to the student + guardians.
- [ ] A student sees only **their own** submission and only homework/materials for **their** enrolled class-subjects; a teacher sees only **their** class-subjects'; a parent sees their child's; an admin sees all — enforced server-side (PRP-12), not by the client.
- [ ] Study materials (file or link) are CRUD-able per class-subject and visible to that class; syllabus units track PLANNED/IN_PROGRESS/COVERED + % and roll up coverage.
- [ ] All writes are write-gated (PRP-15) + permission-gated (eight new keys, PRP-17); publish/grade/material-delete/syllabus-update are audited (PRP-18, no bodies). Submission/material/homework attachments are gated S3 objects (a non-member can't fetch a submission file).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name homework_materials_syllabus` applies.
- Manual (against P2 + PRP-29/30/32 + PRP-54 seed): as a teacher of section A's Math, create + publish homework → confirm `ASSIGNED` rows for A's enrolled students + a `homework.assigned` `IN_APP`/push to a guardian; as a student in A, submit a file → status `SUBMITTED`; as the teacher, grade it → `homework.graded` to the student; confirm a student in section B can't see A's homework, and a student can't see another student's submission; post a FILE + a LINK material → visible to A; add syllabus units + mark one COVERED → coverage reflects it; force READ_ONLY → publish/submit/grade rejected.

## 8. Risks & rollback
- ⚠︎ **O-P6 template catalog:** the `homework.assigned`/`homework.graded` copy seeds into PRP-54's catalog; refined as O-P6 resolves. **No auto-grading / quiz engine in v1** — homework is instructions + file/text submission; an MCQ/auto-grade engine is a flagged follow-up, not this PRP.
- **Pre-seed vs lazy submissions:** v1 pre-seeds `ASSIGNED` rows at publish (so the grading grid is complete) — but a **late enrollment** (a student joins the section after publish) needs a reconcile (seed missing rows on read, or on enrollment-change). Keep the seeding in one place; document the late-enroll edge ⚠︎.
- **Scoping is the security boundary (PRP-12):** the teacher-assignment ∪ enrollment ∪ guardian predicate must be server-enforced on every read/write — a student must never reach another's submission, a teacher never another class's homework. Put it in one helper reused across the three modules; the FE (PRP-59) gates are UX only.
- **Attachment volume/security:** submission files can be large + numerous (a class × many assignments) — use presigned direct-to-S3 upload (don't proxy bytes through the API), enforce content-type/size limits, and gate GETs by the visibility predicate (presigned, short-lived). A submission file is the student's — never expose it cross-student.
- **Fan-out noise:** `homework.assigned` to a whole section × guardians × channels is a broadcast (same scale caveat as PRP-55) — resolve recipients with set queries, de-dupe a guardian of two children in the class, and lean on PRP-54's `dedupeKey`. Materials/syllabus deliberately **don't** notify by default to avoid spam.
- **Homework marks ≠ report-card marks:** `marksAwarded` here is formative/assignment scoring, **separate** from PRP-50's `MarksEntry` — don't conflate them into report cards (a future, explicit link if the school wants assignment weightage; out of scope now).
- Rollback: additive — drop the five models + four enums, revert the three modules + the template seed. PRP-54 and the rest are unaffected; the catch-all FE route reclaims unused paths.
