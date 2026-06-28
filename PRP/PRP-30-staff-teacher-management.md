# PRP-30 — Staff/teacher onboarding & management

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🟠 Med · **Size:** L
> **Addresses:** P2-BE-30 (implementation-plan §P2, master-prp §6, decisions D16/D19) · **Depends on:** PRP-17 (RBAC — `staff.*` / `teacher_assignment.*` permissions; teacher/staff role abilities), PRP-21 (reuses the admin-invite/setup-password flow it generalizes), PRP-29 (`TeacherAssignment` targets a `Section`×`Subject`), PRP-28 (assignments are year-scoped) · **Feeds:** PRP-34 (bulk import of staff), PRP-38/P3 (subject teacher resolves attendance marking rights from `TeacherAssignment`), P5 (marks entry rights)

## 1. Problem / current state
The schema already has `TeacherProfile` and `StaffProfile` (`prisma/schema.prisma:137-165`), each keyed 1:1 off `UserSchool` with thin fields (`employeeCode`, `department` as a free-text string, `qualification`/`designation`). But there is **no onboarding flow for staff/teachers** (only the developer-created founding admin exists), **no `Department` entity** (department is a loose string), and **no `TeacherAssignment`** linking a teacher to the section×subject they teach for a year. Decision **D19** requires teachers to be assigned to class-section-subject so that subject-wise attendance (P3) and marks entry (P5) can resolve "may this teacher mark this section's Maths?".

The invite mechanism exists and is proven: `createPasswordSetupInvite` (`src/modules/auth/token.service.ts:11`) + `emailTemplateService.sendTemplate({ template: 'schoolAdminInvite' })` (used in `developer.service.ts:132-153`). PRP-21 generalizes it for additional admins. This PRP reuses that **same** invite path for STAFF/TEACHER members rather than inventing a new one.

## 2. Goal & non-goals
- **Goal:** a `Department` model + a `TeacherAssignment` (teacher × section × subject × year) model; extend `TeacherProfile`/`StaffProfile` with the HR fields needed for onboarding; a `src/modules/staff/` module with: invite-a-member (STAFF or TEACHER) reusing the existing invite flow, profile management, department CRUD, and assignment CRUD.
- **Non-goals:** payroll (P8/PRP-67 — explicitly deferred), leave management / staff attendance (P3/PRP-39), bulk import (PRP-34 — this PRP exposes the single-member create the importer reuses per row), the founding-admin/owner flows (PRP-16/PRP-21), the FE screens (PRP-36). ⚠︎ **HR depth** (leave types, document checklist, full HR record) is gated on **O-P2** — see §2.1.

### 2.1 ⚠︎ Open question (O-P2 — staff HR depth)
master-prp §10 leaves the **staff HR depth** open (leave types; payroll in/out; document checklist). **Assumption (stated inline, flagged):** v1 stores a **minimal HR record** — `employeeCode`, `department` (now FK), `designation`, `qualification`, `dateOfJoining`, `employmentType` (FULL_TIME/PART_TIME/CONTRACT), `bloodGroup`, emergency-contact, plus a generic `StaffDocument` table (mirroring PRP-31's `StudentDocument`) for arbitrary uploads. **Leave types and payroll fields are explicitly out** until O-P2 resolves; the document table is generic so a later HR-depth PRP adds rows, not columns. Any reviewer expanding HR depth should resolve O-P2 first.

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
Extend the existing profiles (additive columns; keep current fields):
```prisma
model TeacherProfile {
  // … existing: teacherProfileId, schoolId, userSchoolId, employeeCode, department(string→deprecated), qualification …
  departmentId   String?        // NEW → Department (replaces free-text `department`; keep old col one release for migration)
  designation    String?
  dateOfJoining  DateTime?
  employmentType EmploymentType @default(FULL_TIME)
  bloodGroup     String?
  emergencyContact String?
  departmentRef  Department?    @relation(fields: [departmentId], references: [departmentId])
  assignments    TeacherAssignment[]
  documents      StaffDocument[]
}

model StaffProfile {
  // … existing fields …
  departmentId   String?
  dateOfJoining  DateTime?
  employmentType EmploymentType @default(FULL_TIME)
  bloodGroup     String?
  emergencyContact String?
  departmentRef  Department?    @relation(fields: [departmentId], references: [departmentId])
  documents      StaffDocument[]
}

enum EmploymentType { FULL_TIME PART_TIME CONTRACT }

model Department {
  departmentId String   @id @default(uuid())
  schoolId     String
  name         String                            // "Science", "Administration"
  headUserSchoolId String?                        // optional HOD → UserSchool (no FK; loose ref)
  school       School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  teacherProfiles TeacherProfile[]
  staffProfiles   StaffProfile[]
  createdAt    DateTime @default(now())

  @@unique([schoolId, name])
  @@index([schoolId])
}

model TeacherAssignment {
  teacherAssignmentId String   @id @default(uuid())
  schoolId            String
  academicYearId      String                       // year-scoped (PRP-28)
  teacherProfileId    String
  sectionId           String                       // → Section (PRP-29)
  subjectId           String?                      // null = class-teacher (whole-section) assignment; set = subject teacher
  isClassTeacher      Boolean  @default(false)
  teacherProfile      TeacherProfile @relation(fields: [teacherProfileId], references: [teacherProfileId], onDelete: Cascade)
  school              School         @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([academicYearId, sectionId, subjectId, teacherProfileId])
  @@index([schoolId])
  @@index([academicYearId, sectionId])
  @@index([teacherProfileId])
}

model StaffDocument {
  staffDocumentId  String   @id @default(uuid())
  schoolId         String
  teacherProfileId String?
  staffProfileId   String?
  docType          String                          // "ID_PROOF", "CERTIFICATE", … (free-text v1, ⚠︎ O-P2)
  fileKey          String                          // S3-compatible object key (master-prp §5.6)
  fileName         String?
  teacherProfile   TeacherProfile? @relation(fields: [teacherProfileId], references: [teacherProfileId], onDelete: Cascade)
  staffProfile     StaffProfile?   @relation(fields: [staffProfileId], references: [staffProfileId], onDelete: Cascade)
  school           School          @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  uploadedAt       DateTime @default(now())

  @@index([schoolId])
}
```
Add `departments`, `teacherAssignments`, `staffDocuments` back-relations to `School`. `subjectId`/`sectionId` reference PRP-29 models (add the inverse relations on `Section`/`Subject` there, or keep them as loose indexed FKs to avoid a circular edit — prefer explicit relations and coordinate the PRP-29 edit, see §8). `TeacherAssignment.subjectId IS NULL` denotes a class-teacher (whole-section) assignment; this is the row P3 reads for daily attendance, while subject rows drive period/subject attendance and marks.

> **Decision — reuse the invite flow, don't fork it:** a new STAFF/TEACHER member is onboarded with the **same** `createPasswordSetupInvite` + `schoolAdminInvite`-style template that `developer.service.ts`/PRP-21 use. The only differences are `UserSchool.primaryRole` (STAFF or TEACHER) and which profile table is created. Generalize the email into a role-agnostic `memberInvite` template (or parameterize `schoolAdminInvite`) rather than duplicating the transaction.

### 3.2 Module layout (`src/modules/staff/`)
- `staff.routes.ts` / `staff.controller.ts` / `staff.service.ts` / `staff.schema.ts` / `staff.types.ts`.
- `staff.service.ts` reuses `src/modules/auth/auth.utils.js` (`normalizeEmail`, `isEmail`, `buildUsernameFromEmail`, `hashPassword`), the `generateUniqueUsername` pattern from `developer.service.ts`, `createPasswordSetupInvite` from `src/modules/auth/token.service.js`, and `emailTemplateService` from `src/modules/email/email-template.service.js`.

### 3.3 Services & routes
`staff.service.ts` exports (`fastify`-first, tenant-scoped):
- `inviteMember(fastify, schoolId, { role: STAFF|TEACHER, name, email, phone, profile })` — one transaction mirroring `developer.service.ts:73-144`: create `User` (`INACTIVE`, placeholder hash), `UserSchool(primaryRole, isActive: true)`, the matching `TeacherProfile`/`StaffProfile`, then `createPasswordSetupInvite` + send the (generalized) invite email. Maps `P2002` on `employeeCode`/`email`/`phone` to `fastify.httpErrors.conflict` like the developer path. **This single-member create is the unit PRP-34 calls per CSV row.**
- `listMembers(fastify, schoolId, { role?, departmentId?, cursor?, limit? })`, `getMember`, `updateMemberProfile`, `deactivateMember` (sets `UserSchool.isActive: false` — soft, never hard-deletes a member with history).
- Departments: `createDepartment`/`listDepartments`/`updateDepartment`.
- Assignments: `createAssignment(fastify, schoolId, { academicYearId, teacherProfileId, sectionId, subjectId?, isClassTeacher })` — validates the section + subject belong to the school and (if `subjectId`) is a `ClassSubject` of the section's grade/stream (PRP-29); `listAssignments({ academicYearId, sectionId?, teacherProfileId? })`; `removeAssignment`. `academicYearId` defaults via `resolveCurrentAcademicYear` (PRP-28).

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations `requireWritableSchool` PRP-15):
- `POST /api/school/members` (`staff.invite`) · `GET /api/school/members` (`staff.read`) · `GET /api/school/members/:userSchoolId` (`staff.read`) · `PATCH /api/school/members/:userSchoolId` (`staff.update`) · `POST /api/school/members/:userSchoolId/deactivate` (`staff.deactivate`)
- `POST|GET /api/school/departments` (`staff.manage`/`staff.read`)
- `POST|GET /api/school/teacher-assignments` (`teacher_assignment.manage`/`teacher_assignment.read`), `DELETE /api/school/teacher-assignments/:teacherAssignmentId` (`teacher_assignment.manage`)

### 3.4 Permission strings (extends PRP-17 §3.4)
| Resource | Actions (P2) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `staff` | `read`, `invite`, `update`, `deactivate`, `manage` | all | read | read (self via `profile.*`) | – | – |
| `teacher_assignment` | `read`, `manage` | read+manage | read+manage | read (own) | – | – |

(`member.*` in PRP-17 covers generic membership; `staff.*` is the HR-record surface. A TEACHER reads only their own assignments — enforce the "own" filter in the service, not the matrix.)

## 4. Implementation steps
1. **Schema:** add `EmploymentType`, `Department`, `TeacherAssignment`, `StaffDocument`; extend `TeacherProfile`/`StaffProfile` with the §3.1 columns (additive; keep the legacy `department` string one release, backfill `departmentId` where it maps); add `School` back-relations + the `Section`/`Subject` inverse relations (coordinate with PRP-29). `pnpm exec prisma migrate dev --name staff_and_assignments` then `pnpm prisma:generate`.
2. **Generalize the invite email:** add (or parameterize) a role-agnostic `memberInvite` template in `src/modules/email/` so STAFF/TEACHER invites don't fork `schoolAdminInvite`.
3. **Module:** add `src/modules/staff/{routes,controller,service,schema,types}.ts`; reuse the auth utils/token-service/email helpers listed in §3.2.
4. **Services:** implement `inviteMember` (the per-row unit for PRP-34), profile/department CRUD, and `createAssignment` with the PRP-29 `ClassSubject` validation.
5. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; enforce the "teacher sees only own assignments" filter in the service.
6. **Audit:** `writeAudit()` (PRP-18) on `inviteMember` (`action: 'staff.invite'`), `deactivateMember`, department + assignment mutations.
7. **Schemas/types:** Fastify JSON schemas + request/response types.

## 5. Files added / changed
- **Add:** `src/modules/staff/staff.routes.ts`, `staff.controller.ts`, `staff.service.ts`, `staff.schema.ts`, `staff.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts`, `src/modules/email/email-template.service.ts` (generalize invite template), `src/modules/authz/permissions.ts` (PRP-17 — add `staff.*`/`teacher_assignment.*`), `src/modules/academic/classes.service.ts` (only if a section/subject validation helper is shared)

## 6. Acceptance criteria
- [ ] Inviting a TEACHER/STAFF creates an `INACTIVE` `User` + `UserSchool(role)` + the matching profile and sends a setup-password invite via the **shared** flow (no forked transaction).
- [ ] `Department` + `TeacherAssignment` + `StaffDocument` tables exist with documented constraints; assignments are year-scoped.
- [ ] A subject `TeacherAssignment` is rejected unless the subject is a `ClassSubject` of the section's grade/stream (PRP-29 validation).
- [ ] A class-teacher assignment (`subjectId = null`) is creatable and is the row P3 daily-attendance later resolves.
- [ ] A TEACHER listing assignments sees only their own; an ADMIN sees all.
- [ ] `deactivateMember` is soft (`isActive: false`); no member with history is hard-deleted.
- [ ] HR depth is the minimal §2.1 set; the ⚠︎ O-P2 assumption is recorded in the PRP.
- [ ] Member/department/assignment mutations are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name staff_and_assignments` applies; `pnpm seed:permissions` adds the new strings.
- Manual: invite a teacher → confirm invite email + `INACTIVE` user; create a department; assign the teacher to Section A × Maths (valid) and to a subject the section doesn't offer (expect `400`); list as the teacher → only own rows.

## 8. Risks & rollback
- **⚠︎ O-P2 (HR depth):** the minimal profile (§2.1) is an explicit assumption — leave types/payroll are deferred. A future HR PRP must resolve O-P2 before widening; the generic `StaffDocument` table absorbs document needs without columns.
- **Cross-PRP relation edits:** `TeacherAssignment` references PRP-29's `Section`/`Subject`; adding the inverse relations touches PRP-29's models. Land PRP-29 first, then add the inverse relations here, or keep loose indexed FKs and skip the inverse — decide in review (prefer explicit relations).
- **Invite-flow reuse:** generalizing `schoolAdminInvite` must not change the existing admin invite behaviour (PRP-16/PRP-21) — keep the admin call site's output identical; only add the role-agnostic variant.
- **`departmentId` migration:** the legacy free-text `department` column is kept one release and backfilled; don't drop it in this PR (separate cleanup once data is migrated).
- Rollback: additive module + tables + columns; revert the module, drop the new tables, and drop the additive columns (the legacy `department` string still works).
