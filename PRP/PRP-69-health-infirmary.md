# PRP-69 — Health / infirmary (medical records + vaccination)

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟡 Low · **Size:** M
> **Depends on:** PRP-31 (`Student` is the identity every health record links to — guardian linkage drives who sees/consents), PRP-12 (school context / tenant scoping), PRP-17 (`health.*` permissions), PRP-15 (`requireWritableSchool` on writes), PRP-18 (`writeAudit` — health edits are an audited, PII-sensitive action), PRP-30 (the STAFF/`infirmary` role that operates this), PRP-41 (parent multi-child aggregation — a parent reads their child's health card); FE PRP-10 (abilities/`activeSchoolId`), PRP-11 (permission menu/route guards), PRP-24 (`<WriteGate>` + subscription banner), PRP-36 (the student-detail screen this adds a "Health" tab to) · **Feeds:** PRP-72 (a health/infirmary block in the analytics layer — vaccination-compliance counts), PRP-66 (a medical-fitness line on a bonafide/ID artifact, optional)

## 1. Problem / current state
The platform has no health module. Schools run an infirmary (sick-room visits, chronic-condition flags, allergy/medication notes) and, in Indian K-12, must track **vaccination/immunization** status (RTE/school-health-programme expectations, D1). Today none of this is modeled: `Student` (`prisma/schema.prisma:182-201`, extended by **PRP-31**) carries identity + demographics (incl. `bloodGroup` added by PRP-31) but **no medical record, no allergy/condition list, no vaccination history, no infirmary visit log**. There is no place for a school nurse to record "child X visited the infirmary today, was given paracetamol, parent informed", and no place to answer "which Grade-1 students are missing MMR".

This PRP is a thin, **far-future** module on top of the existing identity backbone (PRP-31). It is deliberately scoped — it stores records and surfaces a read-only health card to the guardian; it is **not** a clinical/EMR system.

> ⚠︎ **O-P8 (module priority + depth):** master §10 leaves Extended-module priority and depth open. **Assumptions (inline, flagged ⚠︎):** (a) health is a **records** module, not a clinical decision/EMR tool — no prescriptions engine, no drug-interaction logic, no integration with external health systems; (b) the **vaccine catalog** is a small per-school configurable list (not a hard-coded national schedule) so a school adds the vaccines it tracks without a schema change; (c) consent/visibility = the existing guardian model (PRP-31 `ParentStudent`) — a linked guardian reads their own child's card; no separate medical-consent workflow in v1. Resolving O-P8 may add fields/policy, not restructure these tables.

## 2. Goal & non-goals
- **Goal — Backend:** a `src/modules/health/` module owning four additive tables — `MedicalRecord` (1:1 health profile per `Student`: allergies, chronic conditions, blood group mirror, emergency-contact override, free-text notes), `Vaccination` (per-student dose rows against a configurable `VaccineType`), `VaccineType` (per-school catalog), and `InfirmaryVisit` (a dated sick-room log: complaint, action taken, medication given, whether the guardian was informed, recorded-by). CRUD scoped to the school + the infirmary/admin role, plus a guardian/parent read of their own child's health card via the PRP-41 aggregation.
- **Goal — Frontend:** a **Health** tab on the existing student-detail screen (PRP-36) for staff/admin to view/edit the medical record, log infirmary visits, and record vaccinations; a small **infirmary visit log** screen; and a read-only **Health card** block in the parent child view (PRP-43/41) showing allergies/conditions/blood group + vaccination status. All via a new `src/store/health/` slice.
- **Non-goals:** any clinical workflow (prescriptions, diagnoses, EMR) (⚠︎ O-P8); a medical-consent/e-sign flow (uses the existing guardian link); staff health records (this is **student** health — staff medical/leave is HR/PRP-30/payroll territory); document/file upload of medical certificates beyond a generic `fileKey` (reuse the `StudentDocument` store from PRP-31 if a scan is needed — do **not** add a parallel uploader); the analytics rollup (PRP-72 reads these tables, does not own them); report-card/certificate rendering (PRP-51/66).

## 3. Target design

### 3.1 Backend

#### 3.1.1 Schema (`prisma/schema.prisma`) — additive, all tenant-scoped
```prisma
enum InfirmaryDisposition { RETURNED_TO_CLASS SENT_HOME REFERRED_HOSPITAL OBSERVED }   // outcome of a visit

model VaccineType {                                  // per-school configurable catalog (⚠︎ O-P8: not a hard-coded schedule)
  vaccineTypeId String   @id @default(uuid())
  schoolId      String
  name          String                               // "MMR", "DPT", "Hepatitis B", "COVID-19"
  doseCount     Int      @default(1)                  // recommended doses (informational)
  isActive      Boolean  @default(true)
  vaccinations  Vaccination[]
  school        School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt     DateTime @default(now())
  @@unique([schoolId, name])
  @@index([schoolId])
}

model MedicalRecord {                                 // 1:1 health profile per student
  medicalRecordId   String   @id @default(uuid())
  schoolId          String
  studentId         String   @unique                  // one health profile per student
  bloodGroup        String?                            // mirrors Student.bloodGroup (PRP-31) — health-module copy
  allergies         String?                            // free-text / comma list (⚠︎ generic, not a coded list)
  chronicConditions String?                            // asthma, epilepsy, etc.
  medications       String?                            // routine meds the school should know about
  emergencyContact  String?                            // override of guardian phone for medical emergencies
  notes             String?
  student           Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school            School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([schoolId])
}

model Vaccination {                                   // one row per dose administered/recorded
  vaccinationId String   @id @default(uuid())
  schoolId      String
  studentId     String
  vaccineTypeId String
  doseNumber    Int      @default(1)
  administeredOn DateTime?                             // null = "reported, date unknown"
  notes         String?
  vaccineType   VaccineType @relation(fields: [vaccineTypeId], references: [vaccineTypeId], onDelete: Cascade)
  student       Student     @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school        School      @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt     DateTime @default(now())
  @@unique([studentId, vaccineTypeId, doseNumber])    // a given dose recorded once
  @@index([schoolId])
  @@index([studentId])
}

model InfirmaryVisit {                                // dated sick-room log
  infirmaryVisitId String   @id @default(uuid())
  schoolId         String
  studentId        String
  visitedAt        DateTime @default(now())
  complaint        String?                             // "fever", "fell during PE"
  actionTaken      String?
  medicationGiven  String?
  temperature      String?                             // store as string (e.g. "99.4 F") — no clinical math
  disposition      InfirmaryDisposition @default(RETURNED_TO_CLASS)
  guardianInformed Boolean  @default(false)
  recordedByUserId String?                             // staff (UserSchool/User) who logged it
  student          Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school           School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt        DateTime @default(now())
  @@index([schoolId])
  @@index([studentId])
  @@index([schoolId, visitedAt])                       // "today's visits" list
}
```
Add back-relations to `Student` (`medicalRecord MedicalRecord?`, `vaccinations Vaccination[]`, `infirmaryVisits InfirmaryVisit[]`) and `School` (`vaccineTypes`, `medicalRecords`, `vaccinations`, `infirmaryVisits`). **Coordinate the `Student` edit** with the other PRPs that extend it (PRP-29/31/32/44/45/46 — see §8). `bloodGroup` is duplicated here as a convenience copy because the medical card is the natural read surface; the PRP-31 `Student.bloodGroup` remains the demographic source (note the seam in the PR — keep them in sync on write or read-through to `Student`; the simpler v1 choice is read-through and **drop** the `MedicalRecord.bloodGroup` column if review prefers a single source).

> **Decision — records, not EMR (⚠︎ O-P8):** every field is free-text or a small enum; no clinical computation, no coded vocabularies (ICD/SNOMED), no prescription objects. `VaccineType` is a per-school list so a school tracks exactly the vaccines it cares about. This keeps the module a far-future, low-severity add that PRP-72 can aggregate (compliance counts) without the platform taking on clinical-grade data obligations beyond the existing PII posture.

#### 3.1.2 Module layout (`src/modules/health/`)
`health.routes.ts` / `health.controller.ts` / `health.service.ts` / `health.schema.ts` / `health.types.ts` (house split; controllers thin; service `fastify`-first, tenant-scoped via `request.schoolContext.schoolId`). Enums import from `src/generated/prisma/enums.js`.

#### 3.1.3 Services & routes
`health.service.ts` exports (all tenant-scoped):
- **Medical record:** `getMedicalRecord(fastify, schoolId, studentId)`, `upsertMedicalRecord(fastify, schoolId, studentId, data)` (1:1 upsert).
- **Vaccine catalog:** `listVaccineTypes` / `createVaccineType` / `updateVaccineType` (per-school).
- **Vaccinations:** `recordVaccination(fastify, schoolId, { studentId, vaccineTypeId, doseNumber, administeredOn?, notes? })` (maps `P2002` on the dose-unique → `conflict`), `listVaccinations(studentId)`, `removeVaccination`.
- **Infirmary visits:** `logInfirmaryVisit(fastify, schoolId, { studentId, complaint, actionTaken?, medicationGiven?, disposition, guardianInformed? })` (stamps `recordedByUserId` from `request.user`), `listVisits(fastify, schoolId, { studentId?, from?, to? })` (the per-student history **and** the "today's visits" infirmary feed), `getVisit`, `updateVisit`.
- **Parent/guardian read (via PRP-41):** `getChildHealthCard(fastify, parentUserId, studentId)` — returns the medical record + vaccination list for a child the parent is linked to (PRP-31 `ParentStudent`); **forces** the parent's own linkage, never trusts a client `studentId`. Exposed through PRP-41's parent subtree.

Routes (school-scoped subtree; mutations `requirePermission('health.manage')` + `requireWritableSchool`; reads `health.read`):
- `GET|PUT /api/school/students/:studentId/medical-record` (`health.read` / `health.manage`)
- `GET|POST /api/school/students/:studentId/vaccinations` (`health.read` / `health.manage`) · `DELETE …/vaccinations/:vaccinationId`
- `GET|POST /api/school/students/:studentId/infirmary-visits` (`health.read` / `health.manage`) · `GET /api/school/infirmary/visits?from=&to=` (the day feed)
- `GET|POST|PATCH /api/school/vaccine-types` (catalog; `health.read` / `health.manage`)
- Parent: `GET /api/parent/children/:studentId/health` (registered under PRP-41; own-children scoping)

All responses use `successResponse`/`errorResponse`.

#### 3.1.4 Permission strings (extends PRP-17)
| Resource | Actions | ADMIN | STAFF (infirmary) | TEACHER | STUDENT | PARENT |
|----------|---------|:-----:|:-----------------:|:-------:|:-------:|:------:|
| `health` | `read`, `manage` | read, manage | read, manage | read | – | read (own child only) |

PARENT `health.read` is "own children only", enforced in the service via the guardian link (PRP-31), never matrix-wide. (The "infirmary" operator is a STAFF member; per D14 v1 has no per-school custom roles, so it is the STAFF role gated by `health.manage`.)

#### 3.1.5 Audit (PRP-18)
`writeAudit()` on `upsertMedicalRecord`, `recordVaccination`/remove, `logInfirmaryVisit`/`updateVisit`, and vaccine-catalog changes. **PII rule (PRP-31/18):** audit `metadata` holds identifiers + the action only (e.g. `{ studentId, vaccineTypeId }`) — **never** the free-text medical detail (allergies/conditions/complaint) in the audit payload.

### 3.2 Frontend
House conventions (PRP-43/47): UI in `src/modules/<feature>/`, client state/API in `src/store/health/` (`*.store.ts`/`*.services.ts`/`*.type.ts`), server state via **TanStack Query** (PRP-09), routes from **`APP_ROUTES`** only, responses normalized through `helper.successResponse`/`helper.errorResponse`, classes via `cn()`, writes gated by PRP-24's `<WriteGate>` + the PRP-11 `<Can>` guard, permission keys mirrored from the backend (PRP-17/this PRP) — never hand-typed.

- **Routes (`src/constants/routes.ts`):** add an infirmary feed route under `APP_ROUTES.school` (e.g. `infirmary`) → `/infirmary`. The student health view is a **tab on the existing student detail** (PRP-36 `students/[studentId]`), so it reuses that route — no new student route. The parent child-health block lives under the existing parent child route (PRP-43 `parent/child/[studentId]`).
- **State & services (`src/store/health/`):** `health.type.ts` mirrors the backend `MedicalRecord`/`Vaccination`/`VaccineType`/`InfirmaryVisit` shapes verbatim (reuse `SchoolRole`/`PermissionKey` from the PRP-10 RBAC module). `health.services.ts` via `apiClient` + `helper.*`: `fetchMedicalRecord(studentId)`, `saveMedicalRecord(studentId, data)`, `fetchVaccinations(studentId)`/`recordVaccination(...)`/`removeVaccination(id)`, `fetchVisits(params)`/`logVisit(...)`, vaccine-type CRUD, and the parent `fetchChildHealth(studentId)`.
- **UI modules (`src/modules/health/`):**
  - `StudentHealthTab.tsx` — rendered inside the PRP-36 student-detail tab strip: a medical-record form (allergies/conditions/meds/emergency contact, `<WriteGate>`-gated Save), a vaccination table (add-dose modal picking a `VaccineType`), and a per-student infirmary-visit history list.
  - `InfirmaryLogScreen.tsx` (page `app/(school)/infirmary/page.tsx`, thin) — today's visit feed + a "log visit" modal (student picker, complaint, action, medication, disposition, "guardian informed" toggle).
  - `ChildHealthCard.tsx` — a **read-only** block in the parent child view (PRP-43): allergies/conditions/blood group + vaccination status (no edit controls for parents).
- **Menu + guards (`src/constants/project.menu.ts`, PRP-11/25):** add an **Infirmary** entry (STAFF/ADMIN, `health.manage`/`health.read`) pointing at the new route; visibility flows from `deriveAbilities` (PRP-10) — no hardcoded role checks. The student Health tab renders under the PRP-36 detail page (already guarded). The parent card needs no menu entry (it is a block in the existing child view).

## 4. Implementation steps
1. **Backend — schema:** add `InfirmaryDisposition`, `VaccineType`, `MedicalRecord`, `Vaccination`, `InfirmaryVisit` (+ `Student`/`School` back-relations). Resolve the `bloodGroup` duplication seam (§3.1.1) in review. `pnpm exec prisma migrate dev --name health_infirmary` then `pnpm prisma:generate`. Coordinate the `Student` block edit (§8).
2. **Backend — module:** add `src/modules/health/{routes,controller,service,schema,types}.ts`; implement the services in §3.1.3.
3. **Backend — routing + guards:** register the school-scoped subtree under `src/plugins/school.plugin.ts`; `requirePermission('health.read'|'health.manage')` + `requireWritableSchool` on writes; register the parent read under PRP-41's subtree with own-children scoping.
4. **Backend — permissions + audit:** add `health.*` to the PRP-17 permission module + default role map; `writeAudit()` on the mutations with the PII-safe metadata rule (§3.1.5).
5. **Backend — schemas/types:** Fastify JSON schemas (`successEnvelope` style) + request/response types; enums from `src/generated/prisma/enums.js`.
6. **Frontend — routes/types/services:** add the infirmary route to `APP_ROUTES`; add `src/store/health/{health.type,health.services}.ts` mirroring the backend shapes; all calls via `apiClient` + `helper.*`.
7. **Frontend — UI:** add `StudentHealthTab.tsx` (wired into the PRP-36 student-detail tabs), `InfirmaryLogScreen.tsx` (+ thin page), and `ChildHealthCard.tsx` (into the PRP-43 child view); use `<WriteGate>`/`<Can>` on every mutating control; TanStack Query keys + invalidation on mutate.
8. **Frontend — menu/guards:** add the permission-tagged Infirmary entry to `project.menu.ts` (via `APP_ROUTES`, PRP-11).

## 5. Files added / changed
- **Backend — add:** `src/modules/health/health.routes.ts`, `health.controller.ts`, `health.service.ts`, `health.schema.ts`, `health.types.ts`
- **Backend — edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (+ the PRP-41 parent subtree registration), `src/modules/authz/permissions.ts` (PRP-17 — add `health.*`)
- **Frontend — add:** `src/store/health/health.type.ts`, `src/store/health/health.services.ts`, `src/modules/health/StudentHealthTab.tsx`, `src/modules/health/InfirmaryLogScreen.tsx`, `src/modules/health/ChildHealthCard.tsx`, `src/app/(school)/infirmary/page.tsx`, optional `src/store/health/health.queries.ts`
- **Frontend — edit:** `src/constants/routes.ts` (infirmary route), `src/constants/project.menu.ts` (Infirmary entry), the PRP-36 student-detail screen (add the Health tab), the PRP-43 parent child view (add `ChildHealthCard`)

## 6. Acceptance criteria
- [ ] `VaccineType`/`MedicalRecord`/`Vaccination`/`InfirmaryVisit` exist with the documented uniques + indexes; `Student` back-relations added without disturbing existing PRP-31 fields.
- [ ] An infirmary staff member can upsert a student's medical record, record a vaccination dose (duplicate dose → `409`), and log an infirmary visit (with `recordedByUserId` stamped); reads work for ADMIN/STAFF/TEACHER.
- [ ] The "today's visits" feed (`/infirmary/visits?from=&to=`) returns the day's log; the per-student history returns that student's visits.
- [ ] A PARENT sees **only their own child's** health card (medical record + vaccinations) via the PRP-41 route; a client-supplied `studentId` cannot widen scope.
- [ ] Health mutations are audited (PRP-18) with **identifiers-only** metadata (no free-text medical detail in the audit payload).
- [ ] All writes are `health.manage` + `requireWritableSchool`-gated; reads are `health.read`; tenant-scoped throughout.
- [ ] FE: the Health tab/infirmary screen/parent card flow through `store/health/*.services.ts` + TanStack Query (no direct axios); routes from `APP_ROUTES`; mutating controls wrapped in `<WriteGate>`; permission keys match the backend.
- [ ] The ⚠︎ O-P8 assumptions (records-not-EMR, configurable vaccine catalog, guardian-link visibility) are recorded.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name health_infirmary` applies cleanly.
- **Frontend:** `yarn type-check && yarn lint && yarn build`.
- **Manual (against a backend with PRP-31/41 data):** open a student → Health tab → save allergies/conditions, add an MMR dose, log an infirmary visit; open the infirmary feed and see today's visit; as the linked parent, open the child view and see the read-only health card; confirm a parent cannot read another child's card; confirm a duplicate dose returns `409`.

## 8. Risks & rollback
- **PII sensitivity (paramount):** medical data is sensitive minor PII. Keep audit metadata to identifiers only (§3.1.5); honour the master §8 India data-residency note for any stored `fileKey`; the parent read must be hard-scoped to the guardian link (server-side, never client `studentId`). This is the central review checkpoint.
- **Records-not-EMR boundary (⚠︎ O-P8):** resist scope creep into prescriptions/diagnoses/clinical logic — those are out of scope until O-P8 resolves; all fields stay free-text/small-enum so a later decision adds policy, not a clinical engine.
- **`bloodGroup` duplication:** the convenience copy in `MedicalRecord` can drift from `Student.bloodGroup` (PRP-31). Resolve in review — prefer read-through to `Student` (drop the column) unless a health-specific override is wanted; if kept, sync on write. Call this out in the PR.
- **Shared `Student` edit (§8):** PRP-29/31/32/44/45/46 + this PRP all extend `Student`. Land in dependency order and rebase each migration so the `Student` block accretes cleanly (no duplicate relation fields) — the PRP-29 §8 / PRP-31 §8 convention.
- **Far-future / low severity:** this is gated behind O-P8 module-priority; if deprioritized it ships later with no impact on earlier phases.
- **Rollback:** additive module + tables + columns on both repos; revert the modules, drop the four tables, drop the `Student`/`School` back-relations. The FE tab/screens are inert if the routes are reverted (the catch-all reclaims `/infirmary`).
