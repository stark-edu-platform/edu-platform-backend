# PRP-33 — Admissions (inquiry → application → enroll)

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🟠 Med · **Size:** L
> **Addresses:** P2-BE-33 (implementation-plan §P2, master-prp §6) · **Depends on:** PRP-31 (converts an application into a `Student` via `createStudent`; reuses the guardian model), PRP-32 (an admitted applicant gets an `Enrollment` via `enrollStudent`), PRP-28 (applications target an intake `AcademicYear`), PRP-29 (an application names a desired `Grade`/`Stream`), PRP-17 (`admission.*` permissions) · **Feeds:** PRP-37 (admissions UI). **⚠︎ gated on O-P2** (admission form fields & workflow depth)

## 1. Problem / current state
There is **no admissions pipeline**. Today a student can only be created directly (PRP-31's `createStudent`), which assumes the decision is already made. A real school runs a funnel: an **inquiry** comes in → a formal **application** is submitted (with documents + fee) → it is **reviewed** (shortlist/interview/test) → **accepted or rejected** → on acceptance it **converts** into a first-class `Student` (PRP-31) **and** an `Enrollment` (PRP-32) for the intake year/section. master-prp §6 lists "basic admissions" for P2; this PRP models that lifecycle and the **conversion** into the existing identity + enrollment records — it does **not** invent a parallel student store.

### 1.1 ⚠︎ Open question (O-P2 — admission fields & workflow depth)
master-prp §10 leaves **admission form fields and workflow depth** open. This PRP is explicitly **⚠︎-flagged** in the implementation plan. **Assumption (inline, flagged):** v1 ships a **minimal, generalizable** pipeline — a single `AdmissionApplication` with a small fixed core (applicant name/DOB/gender, desired grade/stream/year, guardian contact) plus a **`formData Json`** blob for school-specific extra fields, and a **linear status flow** (`INQUIRY → APPLIED → UNDER_REVIEW → OFFERED → ACCEPTED|REJECTED|WITHDRAWN`) with **no** configurable multi-stage workflow, no entrance-test scoring engine, and no application-fee *collection* (a fee can be *recorded* as paid/unpaid only — gateway is P7/D7). Any reviewer needing typed fields, test scoring, or a configurable funnel must **resolve O-P2 first**; the `formData` blob absorbs field variation without a schema change until then.

## 2. Goal & non-goals
- **Goal:** an `AdmissionApplication` model (linear lifecycle + `formData` blob) + an optional `AdmissionDocument` store; a `src/modules/admission/` module with intake CRUD, status transitions, and a **convert-to-student** action that calls PRP-31 `createStudent` + PRP-32 `enrollStudent` in one transaction; an optional **public** inquiry endpoint (rate-limited) so prospective parents can submit an inquiry without an account.
- **Non-goals:** configurable multi-stage workflows / entrance-test scoring (⚠︎ O-P2 — deferred), application-fee **collection** via gateway (P7), document-checklist *policy* (shares PRP-31's generic-document assumption), the FE pipeline UI (PRP-37), bulk import of applications (PRP-34 imports students/staff, not applications). The student/guardian/enrollment **records** are owned by PRP-31/PRP-32; this PRP only **feeds** them on conversion.

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```prisma
enum AdmissionStatus {
  INQUIRY        // captured lead (may originate from the public endpoint)
  APPLIED        // formal application submitted
  UNDER_REVIEW   // shortlist / interview / test stage (single combined stage in v1, ⚠︎ O-P2)
  OFFERED        // seat offered
  ACCEPTED       // converted → Student + Enrollment exist
  REJECTED
  WITHDRAWN
}

model AdmissionApplication {
  applicationId    String          @id @default(uuid())
  schoolId         String
  academicYearId   String                              // intake year (PRP-28)
  applicationNo    String                              // unique per school (auto-numbered)
  // — minimal fixed core (⚠︎ O-P2: everything else lives in formData) —
  applicantFirstName String
  applicantLastName  String?
  dateOfBirth      DateTime?
  gender           String?
  desiredGradeId   String                              // → Grade (PRP-29)
  desiredStreamId  String?                             // → Stream (senior grades only)
  guardianName     String
  guardianEmail    String?
  guardianPhone    String?
  formData         Json            @default("{}")      // school-specific extra fields (⚠︎ O-P2)
  status           AdmissionStatus @default(INQUIRY)
  reviewNotes      String?
  feeStatus        String?                             // "PAID" | "UNPAID" | null — recorded only, no gateway (D7)
  // — conversion link (set on ACCEPTED) —
  convertedStudentId String?       @unique             // → Student (PRP-31), null until converted
  source           String?                             // "PUBLIC" | "WALK_IN" | "REFERRAL" …
  documents        AdmissionDocument[]
  school           School          @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  @@unique([schoolId, applicationNo])
  @@index([schoolId])
  @@index([academicYearId, status])
  @@index([status])
}

model AdmissionDocument {
  admissionDocumentId String   @id @default(uuid())
  schoolId            String
  applicationId       String
  docType             String                            // generic (⚠︎ O-P2)
  fileKey             String                            // S3-compatible (master-prp §5.6)
  fileName            String?
  application         AdmissionApplication @relation(fields: [applicationId], references: [applicationId], onDelete: Cascade)
  school              School               @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  uploadedAt          DateTime @default(now())
  @@index([schoolId])
  @@index([applicationId])
}
```
Add `admissionApplications`, `admissionDocuments` back-relations to `School`. `convertedStudentId` is a loose unique ref to PRP-31's `Student` (no FK relation needed — it's set once at conversion; keeps the admission module from owning a `Student` relation).

> **Decision — convert, don't duplicate:** the application is a **lead/intake record**, not a student. On `ACCEPTED`, `convertToStudent` runs **one transaction** that calls PRP-31 `createStudent` (generating the `admissionNo`, linking the guardian — inviting a PARENT account if requested) and PRP-32 `enrollStudent` (placing them in the intake year's section, seeding `StudentSubject`), then stamps `convertedStudentId` + `status = ACCEPTED`. There is exactly **one** student-creation path (PRP-31); admissions reuses it via the `tx` parameter both PRPs expose.

### 3.2 Module layout (`src/modules/admission/`)
- `admission.routes.ts` / `admission.controller.ts` / `admission.service.ts` / `admission.schema.ts` / `admission.types.ts`.
- Imports `createStudent` (PRP-31), `enrollStudent` (PRP-32), `resolveCurrentAcademicYear` (PRP-28); reuses PRP-01's rate-limiter config for the public inquiry route (mirrors PRP-16's public `/schools/request`).

### 3.3 Services & routes
`admission.service.ts` exports (`fastify`-first, tenant-scoped except the public inquiry):
- `createApplication(fastify, schoolId, data)` — auto-numbers `applicationNo` (unique per school; retry on `P2002`); validates `desiredGradeId`/`desiredStreamId` against PRP-29 (stream only on senior grade).
- `submitPublicInquiry(fastify, subdomain, data)` — **unauthenticated**, resolves the school by subdomain, creates an `INQUIRY` row with `source: 'PUBLIC'`, returns a neutral acknowledgement (mirrors PRP-16 `POST /schools/request` — no data leakage, rate-limited).
- `listApplications(fastify, schoolId, { status?, academicYearId?, cursor?, limit? })`, `getApplication`, `updateApplication`, `transitionStatus(fastify, schoolId, applicationId, toStatus)` — enforces the **linear** flow (illegal jump → `fastify.httpErrors.conflict`), audited.
- **`convertToStudent(fastify, schoolId, applicationId, { sectionId, inviteGuardian? })`** — only legal from `OFFERED`/`UNDER_REVIEW`; in one transaction: `createStudent(tx)` (PRP-31) + optional guardian invite + `enrollStudent(tx)` (PRP-32) → stamp `convertedStudentId`, set `ACCEPTED`. Idempotent: refuses if `convertedStudentId` is already set. Audited (`admission.convert`).
- Documents: `addApplicationDocument`/`listApplicationDocuments`/`removeApplicationDocument` (metadata only; file to S3 out-of-band).

Routes:
- **Public:** `POST /api/admissions/inquiry` (unauthenticated, top-level `/api`, rate-limited per PRP-01 — registered alongside PRP-16's public route, **outside** the school-scoped guard).
- School-scoped (`requirePermission` PRP-17; mutations `requireWritableSchool` PRP-15): `POST|GET /api/school/admissions` (`admission.manage`/`admission.read`) · `GET /api/school/admissions/:applicationId` (`admission.read`) · `PATCH /api/school/admissions/:applicationId` (`admission.manage`) · `POST /api/school/admissions/:applicationId/transition` (`admission.manage`) · `POST /api/school/admissions/:applicationId/convert` (`admission.convert`) · `POST|GET /api/school/admissions/:applicationId/documents` (`admission.manage`/`admission.read`).

### 3.4 Permission strings (extends PRP-17 §3.4)
| Resource | Actions (P2) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `admission` | `read`, `manage`, `convert` | all | read, manage | – | – | – |

(`convert` is the high-impact action creating a real student — kept distinct so it can be granted narrowly. The public inquiry needs no permission — it is unauthenticated like PRP-16's request endpoint.)

## 4. Implementation steps
1. **Schema:** add `AdmissionStatus`, `AdmissionApplication`, `AdmissionDocument` + `School` back-relations. `pnpm exec prisma migrate dev --name admissions` then `pnpm prisma:generate`.
2. **Module:** add `src/modules/admission/{routes,controller,service,schema,types}.ts`; import the PRP-28/29/31/32 helpers in §3.2.
3. **Services:** implement application CRUD, the **linear** `transitionStatus`, the public inquiry (rate-limited, neutral ack), and the **`convertToStudent`** transaction (composing PRP-31 `createStudent` + PRP-32 `enrollStudent`).
4. **Routing:** register the public `/api/admissions/inquiry` alongside PRP-16's public route (no school guard; PRP-01 rate-limit `config`); register the school-scoped routes under `src/plugins/school.plugin.ts` with `requirePermission` + `requireWritableSchool`.
5. **Audit:** `writeAudit()` (PRP-18) on `createApplication`, every `transitionStatus`, and `convertToStudent` (`action: 'admission.convert'`, with the new `studentId`/`enrollmentId` in metadata).
6. **Schemas/types:** Fastify JSON schemas + request/response types; enums from `src/generated/prisma/enums.js`.

## 5. Files added / changed
- **Add:** `src/modules/admission/admission.routes.ts`, `admission.controller.ts`, `admission.service.ts`, `admission.schema.ts`, `admission.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/index.ts` (register the public inquiry route), `src/plugins/school.plugin.ts` (register the scoped routes), `src/modules/authz/permissions.ts` (PRP-17 — add `admission.*`)

## 6. Acceptance criteria
- [ ] `AdmissionApplication` (linear status + `formData` blob) + `AdmissionDocument` tables exist with documented constraints.
- [ ] `transitionStatus` enforces the linear flow (e.g. `INQUIRY → ACCEPTED` directly is rejected `409`).
- [ ] `convertToStudent` creates a `Student` (PRP-31) **and** an `Enrollment` (PRP-32) in one transaction, seeds the subject roster, optionally invites the guardian, and stamps `convertedStudentId`; re-running it is refused (idempotent).
- [ ] The public `POST /api/admissions/inquiry` works unauthenticated, is rate-limited, resolves the school by subdomain, and returns a neutral acknowledgement (no data leakage) — mirroring PRP-16.
- [ ] No parallel student store is introduced; the only student-creation path is PRP-31's `createStudent`.
- [ ] The ⚠︎ O-P2 assumption (minimal fields + `formData`, linear flow, no fee gateway) is recorded.
- [ ] Application lifecycle + conversion are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name admissions` applies cleanly; `pnpm seed:permissions` adds `admission.*`.
- Manual: submit a public inquiry → `INQUIRY` row + neutral ack; progress APPLIED → UNDER_REVIEW → OFFERED; convert → a `Student` + `Enrollment` appear, application `ACCEPTED`; attempt an illegal status jump (`409`); re-convert (refused).

## 8. Risks & rollback
- **⚠︎ O-P2 is the central caveat:** form fields + workflow depth are unresolved — v1 deliberately ships a minimal core + `formData` blob + linear flow. **Do not** harden typed fields / multi-stage workflows / test scoring until O-P2 is answered; record the assumption (§1.1) prominently so reviewers don't over-build.
- **Conversion atomicity:** `convertToStudent` must create the `Student` + `Enrollment` in **one** transaction (compose PRP-31/PRP-32 via `tx`); a half-converted application (student without enrollment, or a stamped `convertedStudentId` with no student) is the worst outcome. Make it idempotent and transactional; test the rollback path.
- **Public endpoint abuse:** the unauthenticated inquiry is an attack surface — reuse PRP-01's rate-limiter, return a neutral ack (no enumeration of schools/students), and key by IP + subdomain, exactly as PRP-16's `/schools/request`.
- **No fee collection (D7):** `feeStatus` is a recorded label only; do **not** wire any payment gateway here (P7). Avoids RBI payment-aggregator scope creep.
- Rollback: additive module + tables; the public route is inert if unregistered; revert the module + drop the two tables. Converted students/enrollments created before rollback remain valid (they live in PRP-31/PRP-32 tables).
