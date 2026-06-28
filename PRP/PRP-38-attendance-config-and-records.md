# PRP-38 — Attendance config, records & idempotent offline-sync

> **Status:** Proposed · **Phase:** 3 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P3-BE-1 (master-prp §5.7/§6, decisions D19/D20) · **Depends on:** PRP-29 (Grade/Section/Subject/ClassSubject — attendance is per class-section and optionally per subject), PRP-32 (Enrollment — the per-year roster a class is marked against), PRP-31 (Student SIS — the student records marked), PRP-12 (school context / tenant scoping), PRP-18 (`writeAudit()` on edits), PRP-28 (AcademicYear — records are year-scoped) · **Feeds:** PRP-40 (absence alerts + reports read these records), PRP-41 (parent aggregation reads them), PRP-42 (mobile teacher capture + sync writes them), PRP-43 (web attendance admin/teacher views)

## 1. Problem / current state
There is **no attendance model** anywhere. The schema (`prisma/schema.prisma`) carries identity/tenancy (`User`, `School`, `UserSchool`, `Student`, `ParentStudent`) but nothing for academic structure (added by P2 PRP-28/29/32) and nothing for attendance. Decision **D20** requires attendance that is **configurable per class — daily** (one mark per student per day, taken by the class teacher) **or period-wise/subject-wise** (taken by the subject teacher), with statuses **Present / Absent / Late / Leave / Half-day**, and it must be **mobile-first with offline capture + sync** (the daily-habit hero flow, master-prp §6 P3). Senior-secondary subjects are subject-aware (D19), so a period-wise record optionally names a `Subject`.

The hard part is **sync**: a teacher on a phone (PRP-42) marks a class while offline, then the device flushes a batch when connectivity returns — possibly **retrying** a batch it already sent (lost ACK), possibly **re-editing** a mark a colleague also touched. The server contract must be **idempotent** (a replayed batch must not double-write) and must define a deterministic conflict rule. This PRP owns the data model + the write/read/sync API; PRP-42 owns the device side. The exact edit/lock window, biometric capture, and the conflict-resolution policy are **open (master-prp §10 O-P3)** — this PRP ships defensible defaults and flags them ⚠︎.

The only request-scoped authz today is `requireAuth` (`src/middlewares/auth.middleware.ts`) + `requireDeveloper`; PRP-12 adds `requireSchoolContext`/`requirePermission(key)` + `request.schoolContext`, and PRP-15 adds `requireWritableSchool`. Attendance routes layer on all three.

## 2. Goal & non-goals
- **Goal:** `AttendanceConfig` (per class-section: daily vs period mode, allowed statuses, lock policy), `AttendanceRecord` (date, optional period/subject, status, `markedBy`, `source`, `clientRef`, `syncedAt`), an `AttendanceStatus` enum; a marking/edit/read API scoped per PRP-12; and an **idempotent batch sync endpoint** (`POST /school/attendance/sync`) keyed on a stable per-mark client reference so replays are no-ops and a last-writer-wins-by-`markedAt` conflict rule is applied deterministically. `writeAudit()` on every create/edit.
- **Non-goals:** the absence-alert trigger and the report aggregations (PRP-40 — this PRP exposes the queryable records they read), parent multi-child aggregation (PRP-41), staff attendance (PRP-39 — separate model), the mobile capture/queue/flush UI (PRP-42), the web views (PRP-43), biometric/device-hardware ingestion (O-P3 — deferred), and a notification engine (PRP-54 is later; PRP-40 uses a minimal sender).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
```
enum AttendanceMode {
  DAILY            // one mark per student per day (class teacher) — D20
  PERIOD           // per-period / per-subject (subject teacher) — D20
}

enum AttendanceStatus {
  PRESENT
  ABSENT
  LATE
  LEAVE
  HALF_DAY
}

enum AttendanceSource {
  WEB              // marked from the web app (PRP-43)
  MOBILE_ONLINE    // marked on device, written live
  MOBILE_SYNC      // captured offline on device, flushed via /sync (PRP-42)
  IMPORT           // future bulk path
}

model AttendanceConfig {
  attendanceConfigId String         @id @default(uuid())
  schoolId           String                                  // denormalized tenant scope (house convention)
  sectionId          String         @unique                  // one config per class-section (PRP-29 Section)
  academicYearId     String                                  // PRP-28 — config is year-scoped
  mode               AttendanceMode @default(DAILY)
  // which statuses this class may use; defaults to all five (D20)
  allowedStatuses    AttendanceStatus[] @default([PRESENT, ABSENT, LATE, LEAVE, HALF_DAY])
  periodsPerDay      Int?                                    // required/meaningful only when mode = PERIOD
  editWindowHours    Int            @default(48)             // ⚠︎ O-P3 edit/lock window — see §3.6
  isLocked           Boolean        @default(false)          // admin hard-lock (overrides the window)
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
  @@index([schoolId])
  @@index([academicYearId])
}

model AttendanceRecord {
  attendanceRecordId String           @id @default(uuid())
  schoolId           String                                  // denormalized tenant scope
  academicYearId     String                                  // year-scoped (D18) → enables rollover/archival
  sectionId          String                                  // class-section the mark belongs to (PRP-29)
  studentId          String                                  // PRP-31
  enrollmentId       String?                                 // PRP-32 — the per-year enrollment, when resolvable
  attendanceDate     DateTime         @db.Date               // the calendar day (date, not timestamp — see §8 clock note)
  period             Int?                                    // null for DAILY; 1..periodsPerDay for PERIOD
  subjectId          String?                                 // optional; set for subject-wise PERIOD marks (D19)
  status             AttendanceStatus
  remark             String?
  markedByUserId     String                                  // the teacher/admin who set it
  source             AttendanceSource @default(WEB)
  // stable per-mark client key for idempotent sync (§3.4). Composed device-side; unique per logical mark.
  clientRef          String?
  // device-asserted moment the mark was taken (drives last-writer-wins conflict rule, §3.4). Server time for WEB.
  markedAt           DateTime         @default(now())
  syncedAt           DateTime?                                // server-stamped when accepted via /sync
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  // one logical mark per (student, day, period, subject). period/subject NULL collapses for DAILY.
  @@unique([studentId, attendanceDate, period, subjectId], name: "uniq_student_day_slot")
  @@unique([clientRef])                                       // replayed batch with same clientRef → no double-insert
  @@index([schoolId, attendanceDate])
  @@index([sectionId, attendanceDate])
  @@index([studentId, attendanceDate])
  @@index([status])
}
```
Add back-relations on `School`/`Section`/`Student`/`AcademicYear`/`Subject` as the P2 models land (coordinate with PRP-29/31/32 — those PRPs own those models; this PRP only adds the attendance side and the inverse fields). `markedByUserId` is a loose reference (string) like PRP-18's audit columns — we never want a teacher deletion to cascade-wipe historical attendance.

> ⚠︎ **Open (O-P3) — unique-key semantics for NULLs.** Postgres treats `NULL`s as distinct in a unique index, so the `uniq_student_day_slot` constraint does **not** by itself prevent two DAILY rows (both `period = NULL, subjectId = NULL`) for the same student+day. We enforce DAILY single-mark in the service (upsert by `studentId+attendanceDate` when `mode = DAILY`) and keep the composite unique for the PERIOD case; if we later want a DB-level guarantee for DAILY, add a partial unique index `WHERE period IS NULL`. Decide with the O-P3 resolution.

### 3.2 Permission strings (extend PRP-17 / PRP-12 contract)
Attendance introduces these `resource.action` keys — **defined here, mirrored verbatim** by FE PRP-43 and mobile PRP-42 (the cross-cutting permission-string contract, master-prp §7.6). Seed them into PRP-17's default role→permission map:
- `attendance.mark` — create/update marks for a section (TEACHER for assigned sections; ADMIN/STAFF broadly).
- `attendance.read` — read records/registers (ADMIN, STAFF, TEACHER).
- `attendance.config` — edit `AttendanceConfig` (ADMIN; STAFF optionally).
- `attendance.read_own` — a STUDENT reads only their own attendance (consumed by PRP-43's student view; PARENT child-scoped reads go through PRP-41's parent surface, not this key).

The marking guard additionally checks **assignment**: a TEACHER may only mark sections they're assigned to (PRP-30 `TeacherAssignment`) — enforced in the service against `request.schoolContext`, never trusting a client-supplied `sectionId`/`schoolId` (PRP-12 tenant rule).

### 3.3 Module (`src/modules/attendance/`)
Standard split (`routes`/`controller`/`service`/`schema`/`types`), controllers thin, services take `fastify` first arg, enums imported from `src/generated/prisma/enums.js`. Routes registered under PRP-12's school-scoped plugin subtree; mutating routes add `onRequest: [fastify.requireWritableSchool]` (PRP-15) so a READ_ONLY/LOCKED school can't write attendance:

| Method & path | Guard(s) | Purpose |
|---|---|---|
| `GET /school/attendance/config/:sectionId` | `attendance.read` | fetch a section's config |
| `PUT /school/attendance/config/:sectionId` | `attendance.config` + writable | set mode/statuses/window/lock |
| `GET /school/attendance?sectionId=&date=&period=&subjectId=` | `attendance.read` | the register for a section on a day (roster joined from PRP-32 enrollment, each student with their mark or "unmarked") |
| `POST /school/attendance` | `attendance.mark` + writable | mark/upsert one section-day register (array of `{ studentId, status, remark? }`) — the **online** path |
| `PATCH /school/attendance/:attendanceRecordId` | `attendance.mark` + writable | edit a single mark (subject to the edit window, §3.6) |
| `POST /school/attendance/sync` | `attendance.mark` + writable | **idempotent batch sync** from offline devices (§3.4) |
| `GET /school/attendance/summary?sectionId=&from=&to=` | `attendance.read` | lightweight per-student tallies for a range (PRP-40 owns full reports; this is the cheap teacher rollup) |

Services: `getConfig`, `upsertConfig`, `getRegister(sectionId, date, …)` (joins the enrollment roster so the UI shows every enrolled student, marked or not), `markRegister(...)` (online bulk upsert), `editRecord(...)`, `syncBatch(...)` (§3.4), `summarize(...)`. `markRegister`/`syncBatch` resolve the active `academicYearId` (PRP-28) and `enrollmentId` (PRP-32) server-side. **Enrollment resolution (correct against PRP-32's unique):** PRP-32's `Enrollment` is unique on **`(academicYearId, studentId)`** — **not** `(sectionId, studentId)` — because a student has exactly one enrollment per year. So resolve the enrollment by `(activeAcademicYearId, studentId)`, then **verify `enrollment.sectionId === sectionId`** and **reject the mark** (`fastify.httpErrors.badRequest`/a per-mark `rejected` reason in `/sync`) if the student is not enrolled in the section being marked. Do **not** look the enrollment up by `(sectionId, studentId)` — that composite is not unique and would mis-resolve.

### 3.4 Idempotent offline sync (`POST /school/attendance/sync`) — the core contract
The device (PRP-42) accumulates marks offline and flushes a **batch**:
```
// request
{
  sectionId: string,
  marks: Array<{
    clientRef: string,        // stable, device-generated, unique per logical mark (see below)
    studentId: string,
    attendanceDate: string,   // ISO date (YYYY-MM-DD)
    period?: number,          // omitted/null for DAILY
    subjectId?: string,       // optional for subject-wise PERIOD
    status: AttendanceStatus,
    remark?: string,
    markedAt: string          // ISO timestamp asserted by the device when the mark was taken
  }>
}
// response (successResponse envelope)
{ accepted: ClientRefResult[], conflicts: ClientRefResult[], rejected: ClientRefResult[] }
// where ClientRefResult = { clientRef, attendanceRecordId?, status: 'accepted'|'duplicate'|'conflict'|'rejected', reason? }
```
**Idempotency rule (replay-safe):** `clientRef` is the idempotency key. Each mark is applied via an upsert keyed first on `clientRef` (unique), then on the logical `(studentId, attendanceDate, period, subjectId)` slot:
1. If a row with this `clientRef` already exists → **duplicate**: return its id, write nothing (a re-sent batch after a lost ACK is a no-op).
2. Else if a row exists for the same **logical slot** (different/absent `clientRef`) → **conflict resolution (last-writer-wins by `markedAt`)**: if the incoming `markedAt` is newer than the stored `markedAt`, overwrite (status/remark/markedBy/source=`MOBILE_SYNC`/clientRef/markedAt) and return **accepted**; if older-or-equal, keep the stored row and return **conflict** (the device reconciles by pulling the register). ⚠︎ **O-P3:** last-writer-wins by device clock is the v1 default — it is simple and offline-friendly but trusts device time; alternatives (server-receipt order; teacher-of-record precedence; surface-both-for-manual-merge) are the open question. Flagged; the rule lives in **one** pure helper `resolveSyncConflict(incoming, existing) → 'apply' | 'keep'` so it's swappable + unit-tested.
3. Else → **insert** a new row (`source = MOBILE_SYNC`, `syncedAt = now()`).
Every accepted insert/overwrite stamps `syncedAt = now()` and writes an audit entry (`attendance.sync`, §3.5). The whole batch runs in **one transaction**; per-mark results are independent (one conflict doesn't fail the batch). A malformed mark (unknown student, not-enrolled, locked window) → **rejected** with a `reason` (the device drops or surfaces it).

> **`clientRef` composition (documented for PRP-42):** the device composes a deterministic key — e.g. `${deviceId}:${sectionId}:${studentId}:${attendanceDate}:${period ?? 'D'}:${subjectId ?? '-'}` — so re-marking the **same** slot offline overwrites the **same** queued item (one ref per logical mark) and a flush replay carries the identical ref. The server treats it as opaque + unique; PRP-42 owns its exact shape but must keep it stable per logical mark.

### 3.5 Audit (PRP-18)
Call `writeAudit()` (non-blocking) on `attendance.config_update`, `attendance.mark` (bulk register write — one summary entry per section-day, with counts in metadata, not one per student), `attendance.edit` (single-record edit, with before/after status in metadata), and `attendance.sync` (batch — accepted/conflict/rejected counts in metadata). These feed the school-scoped audit viewer (PRP-18/PRP-43). Keep metadata to identifiers + status values (PRP-18 PII note).

### 3.6 Edit / lock window ⚠︎ (O-P3)
`AttendanceConfig.editWindowHours` (default 48) bounds how long after `attendanceDate` a mark may be edited (`PATCH`/sync-overwrite); `isLocked` is an admin hard-lock that overrides the window. A pure helper `isEditable(config, record, now) → boolean` is the single check used by `editRecord` + `syncBatch`. **O-P3 is unresolved** — the window length, whether STAFF/ADMIN can edit past it (an "unlock" action), and whether locks are per-day vs per-period are open. v1: window default 48h, ADMIN bypasses via an explicit `isLocked` toggle; flagged here and surfaced in PRP-43's admin UI.

### 3.7 Config keys (`src/config/shared-env.ts`)
Add `ATTENDANCE_DEFAULT_EDIT_WINDOW_HOURS` (default 48) and `ATTENDANCE_SYNC_MAX_BATCH` (default 500 — caps a single `/sync` payload, fail-fast `413`/`400` beyond it) to `sharedEnvProperties`, `AppConfig`, and `readSharedEnv()` (mirror PRP-15's config additions).

## 4. Implementation steps
1. **Schema:** add the three enums + `AttendanceConfig` + `AttendanceRecord` (+ inverse relations) to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name attendance_config_and_records` then `pnpm prisma:generate`.
2. **Permissions:** add the four `attendance.*` keys to PRP-17's default role→permission seed; document them in the shared permission module so FE PRP-43 / mobile PRP-42 mirror verbatim.
3. **Module:** add `src/modules/attendance/{routes,controller,service,schema,types}.ts`. Implement the pure helpers `resolveSyncConflict` and `isEditable` (in the service or an `attendance.rules.ts`) — both unit-testable. Import enums from `src/generated/prisma/enums.js`.
4. **Register routes** under PRP-12's school-scoped plugin; add `requireWritableSchool` (PRP-15) to all mutating routes; guard reads/writes with `requirePermission(...)` and the teacher-assignment check (PRP-30) in the service.
5. **Sync endpoint:** implement `syncBatch` per §3.4 — single transaction, per-mark independent results, `clientRef` idempotency, `resolveSyncConflict`, `syncedAt` stamping, batch-size cap from config; one audit entry per batch.
6. **Audit:** wire `writeAudit()` at the §3.5 call sites.
7. **Config:** add the two `ATTENDANCE_*` keys to `shared-env.ts`.
8. **Swagger/schemas:** Fastify JSON schemas for every route (request/response), mirroring the `successResponse`/`errorResponse` envelope; document the `/sync` request + the `ClientRefResult` response shape so PRP-42 can code against it.

## 5. Files added / changed
- **Add:** `src/modules/attendance/{routes,controller,service,schema,types}.ts` (+ optional `attendance.rules.ts`)
- **Edit:** `prisma/schema.prisma` (+ migration), `src/config/shared-env.ts`, PRP-17's permission seed/module, the school-scoped plugin registration (`src/plugins/index.ts` or `school.plugin.ts`)

## 6. Acceptance criteria
- [ ] A section can be configured DAILY or PERIOD; DAILY enforces one mark per student per day, PERIOD allows one per `(student, date, period, subjectId)`.
- [ ] `GET /school/attendance` returns the full enrolled roster (PRP-32) for a section-day, each student annotated with their mark or "unmarked".
- [ ] Marking a register writes/updates the marks, scoped to `request.schoolContext.schoolId`; a TEACHER cannot mark a section they're not assigned to (PRP-30); a client-supplied `schoolId` cannot widen scope.
- [ ] `POST /school/attendance/sync` is **idempotent**: re-sending the same batch (same `clientRef`s) inserts nothing the second time and returns `duplicate` for each; a brand-new batch inserts and stamps `syncedAt`.
- [ ] Sync **conflict** resolution is deterministic via `resolveSyncConflict` (last-writer-wins by `markedAt`): a newer incoming mark overwrites; an older one is kept and reported as `conflict`. Unit tests cover apply/keep + the duplicate path.
- [ ] Edits past the edit window (or on a locked config) are rejected by `isEditable`; ADMIN hard-lock blocks all edits.
- [ ] Config edits, register marks, single edits, and sync batches all produce audit entries (PRP-18) with counts/before-after in metadata.
- [ ] Writes are blocked when the school is READ_ONLY/LOCKED (PRP-15 `requireWritableSchool`); reads still work.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name attendance_config_and_records` applies; client regenerates.
- Unit: `resolveSyncConflict` (apply/keep/duplicate), `isEditable` (in-window / out-of-window / locked).
- Manual (curl, against a school with PRP-29/31/32 seed data): set a section to DAILY → `POST /school/attendance` a register → `GET` it back; replay an identical `/sync` batch twice → second is all `duplicate`; send a newer `markedAt` for one slot → `accepted` (overwrite); send an older one → `conflict`; backdate beyond the window → `PATCH` rejected; force the school READ_ONLY → writes `403`, reads OK.

## 8. Risks & rollback
- ⚠︎ **Conflict policy is an open question (O-P3):** last-writer-wins-by-device-clock is the v1 default; it trusts device time and can lose a legitimate later edit if a device clock is skewed. Isolate it in `resolveSyncConflict` so the resolution swaps without touching the endpoint; revisit when O-P3 is decided. **Clock/timezone:** `attendanceDate` is a `@db.Date` (the calendar day in the school's locale — document the assumed school timezone); `markedAt`/`syncedAt` are UTC timestamps. Mismatched device timezones are the main correctness risk for "which day" a mark lands on — PRP-42 must send the date the teacher intends, not derive it from device UTC midnight.
- ⚠︎ **Edit/lock window (O-P3):** the 48h default is a guess; surface it as config and let the O-P3 resolution tune it. Never let a missing/zero window silently allow unlimited backdating — default fail-closed past the window.
- **Idempotency hinges on `clientRef` stability:** if PRP-42 generates a fresh ref per flush instead of per logical mark, replays would double-insert. The contract (§3.4) is explicit; add the unique index as the backstop so even a buggy client can't double-write the same ref.
- **Write amplification on big classes:** a 60-student register is 60 upserts — batch in one transaction; cap `/sync` payloads (`ATTENDANCE_SYNC_MAX_BATCH`). Audit one summary row per batch, not per student (PRP-18 write-amplification note).
- **Cross-PRP ordering:** depends on P2 models (PRP-28/29/31/32) existing. Until they land, the FK/inverse relations can't compile — sequence after P2. The `markedByUserId`/loose-string approach mirrors PRP-18 to avoid cascade coupling.
- Rollback: routes are additive and only active once registered; revert the module + drop the two tables + the two enums (additive migration). No existing behavior changes.
