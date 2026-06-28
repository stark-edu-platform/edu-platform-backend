# PRP-39 — Staff attendance

> **Status:** Proposed · **Phase:** 3 · **Severity:** 🟠 Med · **Size:** M
> **Addresses:** P3-BE-2 (master-prp §5.7/§6, decision D20 extended to staff) · **Depends on:** PRP-30 (Staff/Teacher onboarding — the staff/teacher records marked, `Department`), PRP-12 (school context / tenant scoping), PRP-18 (`writeAudit()`), PRP-28 (AcademicYear — records are year-scoped), PRP-15 (`requireWritableSchool`) · **Pairs with:** PRP-38 (student attendance — same enums/sync pattern reused, not duplicated) · **Feeds:** PRP-40 (staff-attendance reports), PRP-43 (web staff-attendance admin views)

## 1. Problem / current state
Student attendance lands in PRP-38, but **staff/teacher attendance has no model**. Schools need to record whether staff are Present/Absent/Late/Leave/Half-day per day for HR/payroll-adjacent reporting (payroll itself is P8/PRP-67; this PRP only records attendance). The catalog (implementation-plan §P3, row 39) scopes it as `StaffAttendance` (+ optional device hooks later ⚠︎). Biometric / access-control-device ingestion is **open (master-prp §10 O-P3)** — this PRP models manual marking now and leaves a clean seam for a later device feed.

Staff are modeled via `UserSchool` (`primaryRole = STAFF | TEACHER`) + their profile tables (`StaffProfile`/`TeacherProfile`, `prisma/schema.prisma:137-165`), extended by PRP-30 (`Department`, `TeacherAssignment`). A staff member is marked against their `UserSchool` membership (the tenant-scoped identity), not their global `User`.

## 2. Goal & non-goals
- **Goal:** a `StaffAttendance` model (date, status, `markedBy`, optional check-in/out, `source`), reusing PRP-38's `AttendanceStatus` + `AttendanceSource` enums (do **not** fork them); a marking/edit/read API scoped per PRP-12 and gated by PRP-15; `writeAudit()` on writes; and a documented seam for a future device/biometric feed (O-P3) without committing to it now.
- **Non-goals:** student attendance (PRP-38), payroll/leave-balance accounting (P8/PRP-67 — `LEAVE` here is just a daily status, not a leave-ledger), the report aggregations (PRP-40 reads these), the device/biometric integration itself (O-P3 — deferred; only the seam is described), the web UI (PRP-43), offline mobile capture (staff attendance is admin/office-marked on web in v1 — no offline-sync endpoint here; if a mobile self-check-in is wanted later it reuses PRP-38's sync pattern).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Reuse `AttendanceStatus` + `AttendanceSource` from PRP-38 (shared enums; PRP-38 must land first or co-land). Add:
```
model StaffAttendance {
  staffAttendanceId String           @id @default(uuid())
  schoolId          String                                  // denormalized tenant scope
  academicYearId    String                                  // year-scoped (D18)
  userSchoolId      String                                  // the STAFF/TEACHER membership marked (PRP-30)
  departmentId      String?                                 // denormalized from PRP-30 for dept-level reports
  attendanceDate    DateTime         @db.Date
  status            AttendanceStatus                         // PRESENT/ABSENT/LATE/LEAVE/HALF_DAY (reused)
  checkInAt         DateTime?                                // optional; populated by a device feed later (O-P3)
  checkOutAt        DateTime?
  remark            String?
  markedByUserId    String                                   // who recorded it (office/admin) — loose ref (PRP-18 style)
  source            AttendanceSource @default(WEB)           // DEVICE value added when O-P3 is resolved
  markedAt          DateTime         @default(now())
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@unique([userSchoolId, attendanceDate], name: "uniq_staff_day")   // one mark per staff per day
  @@index([schoolId, attendanceDate])
  @@index([departmentId, attendanceDate])
  @@index([status])
}
```
`@@unique([userSchoolId, attendanceDate])` gives the natural single-mark-per-day guarantee (no NULL-collapse problem like PRP-38's slot key, since staff attendance is daily-only). `markedByUserId` is a loose string (PRP-18 convention) so staff deletion never cascade-wipes records. Add the inverse relation on `UserSchool`/`School`/`Department` (coordinate with PRP-30, which owns `Department`).

> ⚠︎ **O-P3 device/biometric seam.** A future biometric/access-device integration would write `StaffAttendance` rows with `source = DEVICE` (add the enum value then) and populate `checkInAt`/`checkOutAt`, deriving `status` from check-in time vs a shift policy. v1 does **not** build this; the columns + the `source` enum extension point exist so it slots in without a migration of existing data. Flagged O-P3.

### 3.2 Permission strings (extend PRP-17 contract)
New `resource.action` keys — defined here, mirrored verbatim by FE PRP-43 (no mobile staff-attendance screen in P3, so PRP-42 does not consume these):
- `staff_attendance.mark` — record/edit staff marks (ADMIN; STAFF with an office role; **not** general TEACHER).
- `staff_attendance.read` — read staff registers/reports (ADMIN, STAFF).
Seed into PRP-17's default role→permission map. The service scopes every query to `request.schoolContext.schoolId` (PRP-12) and never trusts a client `schoolId`/`userSchoolId` outside the active school.

### 3.3 Module (`src/modules/staff-attendance/`)
Standard split; controllers thin; services take `fastify` first; enums from `src/generated/prisma/enums.js`. Registered under PRP-12's school-scoped plugin; mutating routes add `requireWritableSchool` (PRP-15):

| Method & path | Guard(s) | Purpose |
|---|---|---|
| `GET /school/staff-attendance?date=&departmentId=` | `staff_attendance.read` | the staff register for a day (all active STAFF/TEACHER memberships, each with mark or "unmarked") |
| `POST /school/staff-attendance` | `staff_attendance.mark` + writable | mark/upsert a day's register (array of `{ userSchoolId, status, checkInAt?, checkOutAt?, remark? }`) |
| `PATCH /school/staff-attendance/:staffAttendanceId` | `staff_attendance.mark` + writable | edit a single staff mark |
| `GET /school/staff-attendance/summary?from=&to=&departmentId=` | `staff_attendance.read` | per-staff tallies for a range (PRP-40 owns full reports; this is the cheap office rollup) |

Services: `getStaffRegister(date, departmentId?)` (joins the active staff/teacher roster from PRP-30 so the UI lists everyone, marked or not — mirrors PRP-38's roster-join idea), `markStaffRegister(...)` (bulk upsert keyed on `(userSchoolId, attendanceDate)`), `editStaffRecord(...)`, `summarizeStaff(...)`. The active `academicYearId` (PRP-28) + `departmentId` (PRP-30) are resolved server-side from `userSchoolId`, not trusted from the client.

### 3.4 Audit (PRP-18)
`writeAudit()` (non-blocking) on `staff_attendance.mark` (one summary entry per day-register with counts in metadata, not per staff) and `staff_attendance.edit` (single edit, before/after status in metadata). Keep metadata to identifiers + status (PRP-18 PII note).

## 4. Implementation steps
1. **Schema:** add `StaffAttendance` (reusing PRP-38's enums) + inverse relations to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name staff_attendance` then `pnpm prisma:generate`. (Sequence after / with PRP-38 so the shared enums exist.)
2. **Permissions:** add `staff_attendance.mark` / `staff_attendance.read` to PRP-17's default role→permission seed + the shared permission module (FE PRP-43 mirrors them).
3. **Module:** add `src/modules/staff-attendance/{routes,controller,service,schema,types}.ts`; import enums from `src/generated/prisma/enums.js`.
4. **Register routes** under PRP-12's school-scoped plugin; `requireWritableSchool` (PRP-15) on mutating routes; `requirePermission(...)` on all.
5. **Audit:** wire `writeAudit()` at the §3.4 call sites.
6. **Schemas/Swagger:** Fastify JSON schemas for each route, `successResponse`/`errorResponse` envelope.

## 5. Files added / changed
- **Add:** `src/modules/staff-attendance/{routes,controller,service,schema,types}.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), PRP-17's permission seed/module, the school-scoped plugin registration

## 6. Acceptance criteria
- [ ] `GET /school/staff-attendance` lists all active STAFF/TEACHER memberships for a day (PRP-30 roster), each annotated marked/unmarked, scoped to the active school.
- [ ] Marking a register upserts one row per staff per day (`uniq_staff_day`); re-marking the same day updates rather than duplicates.
- [ ] A TEACHER without `staff_attendance.mark` cannot record staff attendance; ADMIN/office-STAFF can; a client-supplied `schoolId`/`userSchoolId` outside the active school is rejected (PRP-12).
- [ ] Reuses PRP-38's `AttendanceStatus`/`AttendanceSource` enums (no duplicate enum); `checkInAt`/`checkOutAt` accept optional values and default null.
- [ ] Marks/edits write audit entries (PRP-18) with counts/before-after in metadata.
- [ ] Writes blocked when the school is READ_ONLY/LOCKED (PRP-15); reads still work.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name staff_attendance` applies.
- Manual (curl, against a school with PRP-30 staff seed): `GET` the register for today → all staff "unmarked" → `POST` marks for a few → `GET` reflects them; re-`POST` the same day → updates, no duplicates; `PATCH` one to LEAVE → audit entry recorded; force READ_ONLY → writes `403`, reads OK.

## 8. Risks & rollback
- ⚠︎ **Device/biometric integration is open (O-P3):** do not build it now; the `source`/`checkInAt`/`checkOutAt` seam exists so a later device feed needs no destructive migration. Avoid premature shift/policy modeling — `status` is a plain daily value in v1.
- **Scope creep into payroll/leave:** `LEAVE` here is a daily status, not a leave-balance ledger (that's P8/PRP-67). Keep this model attendance-only; resist adding leave types/quotas here.
- **Enum sharing with PRP-38:** the shared `AttendanceStatus`/`AttendanceSource` couples the two PRPs — PRP-38 owns them; co-land or sequence PRP-38 first. If PRP-39 must ship independently, it could define its own enums, but the catalog intent is one vocabulary — prefer sharing.
- **Clock/timezone:** `attendanceDate` is a `@db.Date` in the school locale; `checkInAt`/`checkOutAt`/`markedAt` are UTC timestamps (mirror PRP-38's clock note).
- Rollback: additive — revert the module + drop the `StaffAttendance` table (the shared enums stay, owned by PRP-38). No existing behavior changes.
