# PRP-31 — Student SIS + guardian/sibling linkage

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P2-BE-31 (implementation-plan §P2, master-prp §5.7/§6, decision D17) · **Depends on:** PRP-16 (students belong to an activated `School`), PRP-17 (`student.*` / `guardian.*` permissions), PRP-12 (school context / tenant scoping) · **Feeds:** PRP-32 (enrollment links a `Student` to a year/section), PRP-33 (admissions converts an application into a `Student`), PRP-34 (bulk student import reuses the single-student create), P3 attendance / P4 fees / P5 results (all keyed off `Student` + the parent-as-actor model)

## 1. Problem / current state
The identity backbone for **D17** already exists in the schema and must be **extended, not recreated**:
- `Student` (`prisma/schema.prisma:182-201`) — first-class record, `admissionNo` unique per school (`@@unique([schoolId, admissionNo])`), an **optional** login via `userSchoolId String? @unique`, basic demographics (`firstName`/`lastName`/`dateOfBirth`/`gender`/`admissionDate`/`status` as a loose string).
- `ParentProfile` (`:167-180`) — keyed 1:1 off a `UserSchool(PARENT)`, with `occupation`/`relationshipNotes`.
- `ParentStudent` (`:203-217`) — the **many-to-many** guardian link, `@@unique([parentProfileId, studentId])`, `relation` (free-text) + `isPrimary`.

So D17 is *partly* implemented: student-as-record-with-optional-login ✅, parent-as-account-linked-M2M ✅, profile tables ✅. **What's missing:** richer student demographics/contact, a **document** store, **sibling grouping** (D17: siblings), an explicit guardian **relation enum** + the "a student can have up to 2 guardians / a parent can have children across branches" handling, a guardian-account onboarding flow (invite a parent), and the SIS module itself. The `Student.status` free-text needs an enum aligned with the lifecycle PRP-32 owns (ACTIVE/TRANSFERRED/GRADUATED/…). This PRP fills those gaps **on top of** the existing models.

## 2. Goal & non-goals
- **Goal:** extend `Student`/`ParentProfile`/`ParentStudent` with the SIS fields D17 needs; add `StudentDocument` and a `SiblingGroup` (or sibling self-link) for sibling grouping; a `GuardianRelation` enum; a `src/modules/student/` module with student CRUD, document upload metadata, guardian linking (link existing / invite new parent account), and sibling grouping; the single-student create that PRP-33 (admissions) and PRP-34 (import) reuse.
- **Non-goals:** the per-year **enrollment** record + section placement (PRP-32 owns `Enrollment`; this PRP owns the student *identity*, PRP-32 the year placement), the **admissions pipeline** (PRP-33 — it *calls* this PRP's `createStudent`), bulk import (PRP-34 — reuses `createStudent` per row), the FE screens (PRP-36). ⚠︎ the exact **document checklist** is gated on O-P2 — see §2.1.

### 2.1 ⚠︎ Open question (O-P2 — document checklist)
master-prp §10 leaves the **document checklist** (and admission/ID-card fields) open. **Assumption (inline, flagged):** `StudentDocument` is a **generic** table (`docType` free-text + `fileKey`), not a fixed checklist of typed columns, so a later PRP (or admissions PRP-33) can introduce a required-document policy without a schema change. Demographic fields below are the common Indian-K-12 SIS set (RTE-aware per D1: category/quota captured but optional); anything beyond is deferred until O-P2 resolves.

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`) — extend existing models
```prisma
enum StudentStatus { ACTIVE INACTIVE TRANSFERRED GRADUATED WITHDRAWN }   // replaces free-text Student.status (PRP-32 drives transitions)
enum GuardianRelation { FATHER MOTHER GUARDIAN GRANDFATHER GRANDMOTHER OTHER }

model Student {
  // … existing: studentId, schoolId, userSchoolId?, admissionNo, firstName, lastName?, dateOfBirth?, gender?, admissionDate? …
  status          StudentStatus @default(ACTIVE)   // was String? — migrate values
  middleName      String?
  bloodGroup      String?
  nationality     String?
  category        String?                          // RTE/Gen/OBC/SC/ST (D1, optional)
  isRteQuota      Boolean       @default(false)
  addressLine     String?
  city            String?
  state           String?
  postalCode      String?
  photoFileKey    String?                          // S3-compatible (master-prp §5.6)
  siblingGroupId  String?                          // sibling grouping (D17)
  siblingGroup    SiblingGroup? @relation(fields: [siblingGroupId], references: [siblingGroupId])
  documents       StudentDocument[]
  // (PRP-29 adds: studentSubjects StudentSubject[]; PRP-32 adds: enrollments Enrollment[])
}

model ParentProfile {
  // … existing: parentProfileId, schoolId, userSchoolId, occupation?, relationshipNotes?, parentStudents …
  phoneSecondary  String?
  addressLine     String?
  // a parent account links M2M to students (existing ParentStudent); cross-branch handled by separate ParentProfile per school (§3.2)
}

model ParentStudent {
  // … existing: parentStudentId, schoolId, parentProfileId, studentId, isPrimary, relation(string→deprecated) …
  relationKind    GuardianRelation @default(GUARDIAN)   // replaces free-text `relation`; keep old col one release
  isEmergencyContact Boolean       @default(false)
}

model SiblingGroup {
  siblingGroupId String   @id @default(uuid())
  schoolId       String
  students       Student[]
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())
  @@index([schoolId])
}

model StudentDocument {
  studentDocumentId String   @id @default(uuid())
  schoolId          String
  studentId         String
  docType           String                          // generic (⚠︎ O-P2): "BIRTH_CERT", "AADHAAR", "TC_PREVIOUS", …
  fileKey           String
  fileName          String?
  student           Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school            School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  uploadedAt        DateTime @default(now())
  @@index([schoolId])
  @@index([studentId])
}
```
Add `siblingGroups` + `studentDocuments` back-relations to `School`. Keep the legacy `Student.status` migration and `ParentStudent.relation` string one release (backfill into the enums). **Coordinate the `Student` edit with PRP-29** (which adds `studentSubjects`) and PRP-32 (which adds `enrollments`) — see §8.

> **Decision — guardian model (D17 verbatim):** a student has guardians via `ParentStudent` (M2M, ≥0; UI/service caps at **2 primary-ish** guardians but the schema doesn't hard-limit). A **parent account is one `ParentProfile` per school** (since `ParentProfile` carries `schoolId` and is keyed off a school-scoped `UserSchool`); a parent with children **across branches** therefore has one `User` but a `ParentProfile` (and `UserSchool(PARENT)`) **per school** — the cross-branch case is "same `User`, multiple memberships", consistent with the existing `UserSchool` model. `isPrimary` marks the fee/results/comms default actor (D17). **Siblings** share a `SiblingGroup` (cleaner than pairwise self-links for ≥2 siblings).

### 3.2 Module layout (`src/modules/student/`)
- `student.routes.ts` / `student.controller.ts` / `student.service.ts` / `student.schema.ts` / `student.types.ts`.
- Reuses the same onboarding helpers as PRP-30 for the **invite-a-parent** path (`createPasswordSetupInvite`, `emailTemplateService`, `auth.utils.js`), and `resolveCurrentAcademicYear` (PRP-28) is **not** needed here (identity is year-agnostic; year placement is PRP-32).

### 3.3 Services & routes
`student.service.ts` exports (`fastify`-first, tenant-scoped):
- **`createStudent(fastify, schoolId, data, tx?)`** — creates the `Student` record (no login by default; `userSchoolId` stays null unless a student login is explicitly provisioned). Generates/validates `admissionNo` (unique per school; maps `P2002` → `conflict`). **Accepts an optional `tx`** so PRP-33 (admissions conversion) and PRP-34 (import) compose it in their transactions. This is the single creation path — admissions and import do **not** re-implement it.
- `listStudents(fastify, schoolId, { status?, gradeId?, sectionId?, search?, cursor?, limit? })` (section/grade filters join through PRP-32 `Enrollment`), `getStudent` (with guardians, documents, current enrollment), `updateStudent`, `setStudentStatus` (the enum transition; PRP-32's promotion/TC also call this).
- **Guardians:** `linkGuardian(fastify, schoolId, { studentId, parentProfileId, relationKind, isPrimary })` and `inviteGuardian(fastify, schoolId, { studentId, name, email, phone, relationKind, isPrimary })` — the latter, in one transaction, **dedupes by email/phone first**: it looks up an existing `User` by the supplied email (or phone) and, if one is found, **attaches a new `UserSchool(PARENT)` + `ParentProfile` (for this school) + the `ParentStudent` link to that existing `User`** rather than creating a second account (only sending a setup-password invite if that `User` is still INACTIVE / has no usable login). Only when no `User` matches does it create `User`(INACTIVE) + `UserSchool(PARENT)` + `ParentProfile` + the `ParentStudent` link + a setup-password invite (reusing PRP-30's generalized `memberInvite` flow). **This one-parent-one-`User`-many-memberships invariant is the precondition PRP-41's cross-school `/me/children` union relies on** — a parent with children in multiple branches must resolve to a single `User` (with a `UserSchool(PARENT)`/`ParentProfile` per school) so PRP-41 can union their children across schools; creating a duplicate `User` per branch would silently break that aggregation. `unlinkGuardian`, `setPrimaryGuardian`.
- **Siblings:** `linkSiblings(fastify, schoolId, studentIds[])` — creates/joins a `SiblingGroup`; `unlinkSibling`.
- **Documents:** `addStudentDocument(fastify, schoolId, studentId, { docType, fileKey, fileName })` (the file itself is uploaded to S3-compatible storage out-of-band, master-prp §5.6; this stores metadata), `listStudentDocuments`, `removeStudentDocument`.

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations `requireWritableSchool` PRP-15):
- `POST /api/school/students` (`student.create`) · `GET /api/school/students` (`student.read`) · `GET /api/school/students/:studentId` (`student.read`) · `PATCH /api/school/students/:studentId` (`student.update`)
- `POST /api/school/students/:studentId/guardians/link` (`guardian.manage`) · `POST /api/school/students/:studentId/guardians/invite` (`guardian.manage`) · `DELETE /api/school/students/:studentId/guardians/:parentStudentId` (`guardian.manage`)
- `POST /api/school/students/siblings` (`student.update`)
- `POST|GET /api/school/students/:studentId/documents` (`student.update`/`student.read`)
- **Parent self-read:** `GET /api/school/me/children` (`profile.read_self`) — a PARENT lists their linked students (the multi-child base P3/P4 build on); the service forces the parent's own `parentProfileId`.

### 3.4 Permission strings (extends PRP-17 §3.4)
| Resource | Actions (P2) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `student` | `read`, `create`, `update` | all | read, create, update | read | – | read (self only) |
| `guardian` | `manage` | manage | manage | – | – | – |

(PARENT `student.read` is "own children only", enforced in the service via `parentProfileId`, never a matrix-wide read. STUDENT reads self via `profile.read_self`.)

## 4. Implementation steps
1. **Schema:** add `StudentStatus`/`GuardianRelation` enums, `SiblingGroup`, `StudentDocument`; **extend** existing `Student`/`ParentProfile`/`ParentStudent` with the §3.1 fields (additive; migrate `Student.status` string → enum, `ParentStudent.relation` string → `relationKind`, keeping old cols one release). Add `School` back-relations. Coordinate `Student` relation additions with PRP-29/PRP-32. `pnpm exec prisma migrate dev --name student_sis_and_guardians` then `pnpm prisma:generate`.
2. **Module:** add `src/modules/student/{routes,controller,service,schema,types}.ts`. Reuse PRP-30's generalized `memberInvite` email + the auth utils/token-service for the invite-a-parent path.
3. **Services:** implement `createStudent(…, tx?)` (the shared creation path for PRP-33/PRP-34), guardian link/invite, sibling grouping, document metadata, and the parent `me/children` read.
4. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on writes; force `parentProfileId` scoping on the parent self-read.
5. **Audit:** `writeAudit()` (PRP-18) on `createStudent`, `setStudentStatus`, guardian link/invite/unlink, sibling changes.
6. **Schemas/types:** Fastify JSON schemas + request/response types; enums from `src/generated/prisma/enums.js`.

## 5. Files added / changed
- **Add:** `src/modules/student/student.routes.ts`, `student.controller.ts`, `student.service.ts`, `student.schema.ts`, `student.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts`, `src/modules/authz/permissions.ts` (PRP-17 — add `student.*`/`guardian.*`)

## 6. Acceptance criteria
- [ ] `Student`/`ParentProfile`/`ParentStudent` are **extended** (existing fields + relations preserved; `admissionNo` uniqueness intact); `SiblingGroup` + `StudentDocument` added.
- [ ] `Student.status` is the `StudentStatus` enum (migrated from the string) and `ParentStudent.relation` is `relationKind` (`GuardianRelation`).
- [ ] `createStudent` works standalone **and** composes inside a caller's transaction (proven by a PRP-33/PRP-34-style test); duplicate `admissionNo` → `409`.
- [ ] A student can be linked to ≥2 guardians; `isPrimary` marks the default actor; a guardian can be **invited** (creates a PARENT account + setup invite via the shared flow).
- [ ] `inviteGuardian` **dedupes by email/phone**: inviting a guardian whose email/phone already matches an existing `User` attaches a new `UserSchool(PARENT)`+`ParentProfile`+`ParentStudent` to that `User` (no duplicate account); a brand-new email creates the account. This is the one-parent-one-`User` precondition PRP-41's cross-school `/me/children` union depends on.
- [ ] A parent across branches is one `User` with a `ParentProfile`/`UserSchool(PARENT)` per school (no schema change needed for cross-branch).
- [ ] Siblings can be grouped via `SiblingGroup`.
- [ ] A PARENT's `GET /me/children` returns only their linked students (service-scoped, not matrix-wide).
- [ ] The ⚠︎ O-P2 document-checklist assumption is recorded; `StudentDocument` is generic.
- [ ] Student/guardian mutations are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name student_sis_and_guardians` applies; existing `Student`/`ParentStudent` rows migrate (status/relation backfilled).
- Manual: create a student; invite a guardian (parent receives invite); link a sibling; add a document; as the parent, `GET /me/children` → only own children; duplicate `admissionNo` → `409`.

## 8. Risks & rollback
- **Extend, don't recreate (load-bearing):** the existing `Student`/`ParentStudent`/`ParentProfile` rows and the `@@unique([schoolId, admissionNo])` / `userSchoolId @unique` constraints must survive. All changes are additive columns + enum migrations; **do not** drop or rename the existing identity columns. This is the central review checkpoint.
- **Shared `Student` edits across PRPs:** PRP-29 adds `studentSubjects`, PRP-32 adds `enrollments`, this PRP adds `documents`/`siblingGroup`/demographics. Land in dependency order (28 → 29 → 31 → 32) and rebase each migration so the `Student` block accretes cleanly (no duplicate fields).
- **Enum migration of `status`:** map existing free-text values explicitly in the migration (unknown → `ACTIVE`); never let an unmapped value break the column swap. Keep the old string column one release.
- **⚠︎ O-P2:** document checklist + ID-card fields are deferred; `StudentDocument` stays generic so resolving O-P2 adds policy/rows, not columns.
- **PII:** SIS holds minors' PII — keep audit `metadata` to identifiers only (PRP-18 rule); document data-residency (master-prp §8, India region) as the storage constraint for `fileKey` objects.
- Rollback: additive module + tables + columns; revert the module, drop `SiblingGroup`/`StudentDocument`, drop additive columns (the legacy `status`/`relation` strings still work).
